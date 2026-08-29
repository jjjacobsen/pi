// pi-vision: describe images through a configured vision model.
//
// Rules:
// - multimodal primary -> describe_image hidden; pi passes images to the
//   model natively, zero delegation
// - text-only primary  -> describe_image visible; calls delegate to the
//   configured vision model (provider/model in ~/.pi/agent/vision.json)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { toolError } from "./lib/toolkit";

const TOOL_NAME = "describe_image";
const DEFAULT_MAX_DIMENSION = 1568;
const DEFAULT_JPEG_QUALITY = 85;
const TIMEOUT_MS = 60000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const FORCE_COMPRESS_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Config (~/.pi/agent/vision.json). Unknown keys from older configs are
// ignored; only provider/model/maxDimension/jpegQuality are read or written.

function loadConfig() {
  const path = join(getAgentDir(), "vision.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      provider: typeof raw.provider === "string" ? raw.provider : undefined,
      model: typeof raw.model === "string" ? raw.model : undefined,
      maxDimension: Number.isFinite(raw.maxDimension) ? raw.maxDimension : DEFAULT_MAX_DIMENSION,
      jpegQuality: Number.isFinite(raw.jpegQuality) ? raw.jpegQuality : DEFAULT_JPEG_QUALITY,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`pi-vision: config load failed (${error?.message ?? error}), using defaults`);
    return { maxDimension: DEFAULT_MAX_DIMENSION, jpegQuality: DEFAULT_JPEG_QUALITY };
  }
}

function saveConfig(config) {
  writeFileSync(join(getAgentDir(), "vision.json"), JSON.stringify(config, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Capability sync: hide describe_image from multimodal models (they see
// images natively), show it for text-only models.

function isMultimodal(model) {
  return !!model?.input?.includes("image");
}

function syncToolAvailability(pi, model) {
  const active = pi.getActiveTools();
  const has = active.includes(TOOL_NAME);
  const should = !isMultimodal(model);
  if (should && !has) {
    pi.setActiveTools([...new Set([...active, TOOL_NAME])]);
  } else if (!should && has) {
    pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
  }
}

// ---------------------------------------------------------------------------
// Image detection. Only header bytes are inspected.

function unsupportedImage() {
  throw new Error("unsupported image format; supported: png, jpeg, gif, webp");
}

function detectPng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) unsupportedImage();
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") unsupportedImage();
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) unsupportedImage();
  const colorType = bytes[25];
  let hasAlpha = colorType === 4 || colorType === 6;

  for (let offset = 33; !hasAlpha && offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "tRNS") hasAlpha = true;
    if (type === "IEND") break;
    offset = end;
  }

  return { mime: "image/png", width, height, hasAlpha };
}

function detectJpeg(bytes) {
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) break;
    const segmentLength = bytes.readUInt16BE(i + 2);
    if (segmentLength < 2 || i + 2 + segmentLength > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) break;
      const height = bytes.readUInt16BE(i + 5);
      const width = bytes.readUInt16BE(i + 7);
      if (!width || !height) unsupportedImage();
      return { mime: "image/jpeg", width, height, hasAlpha: false };
    }
    i += 2 + segmentLength;
  }
  unsupportedImage();
}

function detectGif(bytes) {
  if (bytes.length < 10) unsupportedImage();
  const signature = bytes.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") unsupportedImage();
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (!width || !height) unsupportedImage();
  return { mime: "image/gif", width, height, hasAlpha: true };
}

function readUInt24LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) >>> 0;
}

function detectWebp(bytes) {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = bytes.toString("ascii", i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    const end = i + 8 + size;
    if (!size || end > bytes.length) break;
    if (fourcc === "VP8X") {
      if (size < 10) unsupportedImage();
      const width = readUInt24LE(bytes, i + 12) + 1;
      const height = readUInt24LE(bytes, i + 15) + 1;
      return { mime: "image/webp", width, height, hasAlpha: (bytes[i + 8] & 0x10) !== 0 };
    }
    if (fourcc === "VP8 ") {
      if (size < 10 || bytes[i + 11] !== 0x9d || bytes[i + 12] !== 0x01 || bytes[i + 13] !== 0x2a) unsupportedImage();
      const width = bytes.readUInt16LE(i + 14) & 0x3fff;
      const height = bytes.readUInt16LE(i + 16) & 0x3fff;
      if (!width || !height) unsupportedImage();
      return { mime: "image/webp", width, height, hasAlpha: false };
    }
    if (fourcc === "VP8L") {
      if (size < 5 || bytes[i + 8] !== 0x2f) unsupportedImage();
      const bits = bytes.readUInt32LE(i + 9);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return { mime: "image/webp", width, height, hasAlpha: ((bits >>> 28) & 1) !== 0 };
    }
    i = end + (size & 1);
  }
  unsupportedImage();
}

function detectImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return detectPng(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return detectJpeg(bytes);
  const signature = bytes.toString("ascii", 0, 6);
  if (bytes.length >= 6 && (signature === "GIF87a" || signature === "GIF89a")) return detectGif(bytes);
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return detectWebp(bytes);
  }
  unsupportedImage();
}

// ---------------------------------------------------------------------------
// Compression via macOS sips. Opaque images become JPEG. Images with alpha
// retain transparency as GIF or PNG. sips cannot write WebP, so alpha WebP
// output is PNG.

function runSips(args, signal) {
  return new Promise((resolvePromise, reject) => {
    execFile("sips", args, { signal, maxBuffer: 16 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        if (signal.aborted) reject(signal.reason);
        else reject(new Error(`image compression failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolvePromise(undefined);
    });
  });
}

async function compressImage(path, info, maxDimension, jpegQuality, signal) {
  const directory = await mkdtemp(join(tmpdir(), "pi-vision-"));
  const toJpeg = !info.hasAlpha;
  const isGif = info.mime === "image/gif";
  const extension = toJpeg ? "jpg" : isGif ? "gif" : "png";
  const format = toJpeg ? "jpeg" : isGif ? "gif" : "png";
  const mime = toJpeg ? "image/jpeg" : isGif ? "image/gif" : "image/png";
  const output = join(directory, `output.${extension}`);
  const args = ["-Z", String(maxDimension), "-s", "format", format];
  if (toJpeg) args.push("-s", "formatOptions", String(jpegQuality));
  args.push(path, "--out", output);

  try {
    await runSips(args, signal);
    const outputStat = await stat(output);
    if (outputStat.size > MAX_SOURCE_BYTES) throw new Error("output exceeds the 64MB cap");
    const bytes = await readFile(output, { signal });
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error("output exceeds the 64MB cap");
    return { bytes, mime };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith("image compression failed:") ? message : `image compression failed: ${message}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function describeImage(params, model, auth, signal) {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("missing prompt");
  const rawPath = params.image_path.trim();
  if (!rawPath) throw new Error("missing image path");
  let path;
  try {
    path = resolve(params.cwd, rawPath);
  } catch {
    throw new Error("invalid image path");
  }

  let sourceStat;
  try {
    sourceStat = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`image not found: ${path}`);
    throw new Error(`cannot read image: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sourceStat.size > MAX_SOURCE_BYTES) throw new Error("image exceeds the 64MB cap");

  let bytes;
  try {
    bytes = await readFile(path, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(`cannot read image: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("image exceeds the 64MB cap");
  const info = detectImage(bytes);
  let payload = bytes;
  let mime = info.mime;
  if (info.width > params.maxDimension || info.height > params.maxDimension || bytes.length > FORCE_COMPRESS_BYTES) {
    const compressed = await compressImage(path, info, params.maxDimension, params.jpegQuality, signal);
    payload = compressed.bytes;
    mime = compressed.mime;
  }

  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const response = await completeSimple(
    requestModel,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: payload.toString("base64"), mimeType: mime },
            { type: "text", text: prompt },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: 4096,
      temperature: 0,
      maxRetries: 1,
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `vision model stopped with ${response.stopReason}`);
  }
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
    || response.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n").trim();
  if (!text) throw new Error("vision model returned no content");
  return { text, usage: response.usage };
}

function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

// ---------------------------------------------------------------------------

export default function visionExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    syncToolAvailability(pi, ctx.model);
  });
  pi.on("model_select", (event) => {
    syncToolAvailability(pi, event.model);
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    if (!event.images || event.images.length === 0) return;
    if (isMultimodal(ctx.model)) return;
    const config = loadConfig();
    const hint =
      config.provider && config.model
        ? "\n\n[An image was attached but the active model cannot see images. Call describe_image with the image's file path to analyze it.]"
        : "\n\n[An image was attached but the active model cannot see images, and no vision model is configured. Run /vision model <provider/model> to enable image analysis.]";
    return { action: "transform", text: event.text + hint };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Describe Image",
    description:
      "Analyze an image file and return a text description or answer questions about it. Delegates to the configured vision model when the active model cannot process images natively. Accepts a file path, absolute or relative to the working directory.",
    promptSnippet: "Analyze an image file and return a text description or answer questions about it",
    promptGuidelines: [
      "Use describe_image when you need to analyze an image file and the active model cannot process images natively. describe_image delegates to the configured vision model and returns its text response.",
    ],
    parameters: Type.Object({
      image_path: Type.String({ description: "Path to the image file to analyze." }),
      prompt: Type.String({ description: "What to analyze, extract, or answer about the image." }),
    }),
    async execute(_toolCallId, params, callerSignal, _onUpdate, ctx) {
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`vision request timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      const abort = () => controller.abort(new Error("vision request aborted"));
      callerSignal?.addEventListener("abort", abort, { once: true });
      if (callerSignal?.aborted) abort();

      try {
        const config = loadConfig();
        if (!config.provider || !config.model) {
          return toolError("describe_image is not configured. Run /vision model <provider/model> first.");
        }
        const visionModel = ctx.modelRegistry.find(config.provider, config.model);
        if (!visionModel) {
          return toolError(`Vision model ${config.provider}/${config.model} not found in the registry. Run /vision model to fix.`);
        }
        if (!visionModel.input?.includes("image")) {
          return toolError(`Vision model ${config.provider}/${config.model} cannot process images. Pick one with image input.`);
        }
        const auth = (await waitFor(
          ctx.modelRegistry.getApiKeyAndHeaders(visionModel),
          controller.signal,
        )) as Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
        if (auth.ok === false) return toolError(`Cannot resolve auth for ${config.provider}/${config.model}: ${auth.error}`);
        if (controller.signal.aborted) throw controller.signal.reason;

        const result = await describeImage(
          {
            image_path: params.image_path,
            prompt: params.prompt,
            cwd: ctx.cwd,
            maxDimension: config.maxDimension,
            jpegQuality: config.jpegQuality,
          },
          visionModel,
          auth,
          controller.signal,
        );
        return { content: [{ type: "text" as const, text: result.text }], details: {}, usage: result.usage };
      } catch (error) {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        const message = timedOut
          ? `vision request timed out after ${TIMEOUT_MS}ms`
          : failure instanceof Error
            ? failure.message
            : String(failure);
        return toolError(message);
      } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", abort);
      }
    },
  });

  pi.registerCommand("vision", {
    description: "Vision model configuration. Subcommands: show, model [<provider/model>].",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";
      const config = loadConfig();

      if (!sub || sub === "show") {
        ctx.ui.notify(
          config.provider && config.model
            ? `Vision model: ${config.provider}/${config.model} (max ${config.maxDimension}px, jpeg ${config.jpegQuality})`
            : "No vision model configured. Use /vision model <provider/model>.",
          "info",
        );
        return;
      }

      if (sub === "model") {
        const value = parts.slice(1).join(" ").trim();
        if (!value) {
          const models = ctx.modelRegistry.getAvailable().filter((m) => m.input?.includes("image"));
          if (models.length === 0) {
            ctx.ui.notify("No vision-capable models found in the registry.", "warning");
            return;
          }
          const choice = await ctx.ui.select(
            "Pick a vision model:",
            models.map((m) => `${m.provider}/${m.id}`),
          );
          if (!choice) return;
          setVisionModel(ctx, config, choice);
          return;
        }
        setVisionModel(ctx, config, value);
        return;
      }

      ctx.ui.notify("Usage: /vision show | /vision model [<provider/model>]", "warning");
    },
  });
}

function setVisionModel(ctx, config, value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) {
    ctx.ui.notify("Usage: /vision model <provider/model>, e.g. /vision model openrouter/xiaomi/mimo-v2.5", "warning");
    return;
  }
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    ctx.ui.notify(`Model ${value} not found in the registry.`, "warning");
    return;
  }
  if (!model.input?.includes("image")) {
    ctx.ui.notify(`Model ${value} cannot process images. Pick one with image input.`, "warning");
    return;
  }
  config.provider = provider;
  config.model = modelId;
  saveConfig(config);
  ctx.ui.notify(`Vision model set to ${provider}/${modelId}.`, "info");
}
