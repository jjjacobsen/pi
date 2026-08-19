// pi-vision: thin TypeScript glue for the Zig vision backend.
//
// pi extensions must be TypeScript modules, so this file registers the
// describe_image tool, keeps its visibility in sync with the active model's
// capability, resolves the configured vision model and its auth from pi's
// model registry, and calls src/vision.zig as a one-shot process: the
// request travels as one JSON argv element via pi.exec (shared callZig
// helper), the binary prints one JSON envelope to stdout and exits. All
// image and HTTP logic lives in Zig.
//
// Rules:
// - multimodal primary -> describe_image hidden; pi passes images to the
//   model natively, zero delegation
// - text-only primary  -> describe_image visible; calls delegate to the
//   configured vision model (provider/model in ~/.pi/agent/vision.json)
//
// Protocol:
//   -> {"op":"describe","path":"...","cwd":"...","prompt":"...","base_url":"...","api_key":"...","model":"...","headers":"...","max_dimension":1568,"jpeg_quality":85,"timeout_ms":60000}
//   <- {"ok":true,"result":"...","usage":{...}} | {"ok":false,"error":"..."}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { callZig } from "./lib/zig";
import { toToolUsage, toolError } from "./lib/toolkit";

const TOOL_NAME = "describe_image";
const DEFAULT_MAX_DIMENSION = 1568;
const DEFAULT_JPEG_QUALITY = 85;
const TIMEOUT_MS = 60000;

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
  } catch {
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
// Tool execution runs through the shared callZig helper (pi.exec + argv
// JSON): Esc SIGTERMs the one-shot binary, which may be blocked in the HTTP
// request, so no call can outlive its turn.

export default function visionExtension(pi: ExtensionAPI) {
  // Resync tool visibility on session start and whenever the model changes.
  pi.on("session_start", (_event, ctx) => {
    syncToolAvailability(pi, ctx.model);
  });
  pi.on("model_select", (event) => {
    syncToolAvailability(pi, event.model);
  });

  // Paste hint: with a text-only primary, pi replaces attached images with
  // "(image omitted: model does not support images)". Append one line so the
  // model knows the image exists and how to analyze it. Multimodal models
  // get the image natively and need nothing.
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(visionModel);
      if (!auth.ok) {
        return toolError(`Cannot resolve auth for ${config.provider}/${config.model}`);
      }
      const headers =
        auth.headers && Object.keys(auth.headers).length > 0
          ? JSON.stringify(Object.entries(auth.headers).map(([k, v]) => [k, String(v)]))
          : "";
      try {
        const res = await callZig(
          pi,
          "pi-vision",
          {
            op: "describe",
            path: params.image_path,
            cwd: ctx.cwd,
            prompt: params.prompt,
            base_url: visionModel.baseUrl,
            api_key: auth.apiKey ?? "",
            headers,
            model: visionModel.id,
            max_dimension: config.maxDimension,
            jpeg_quality: config.jpegQuality,
            timeout_ms: TIMEOUT_MS,
          },
          { signal, timeout: TIMEOUT_MS },
        );
        const usage = toToolUsage(visionModel, res.usage);
        return { content: [{ type: "text" as const, text: res.result }], details: {}, ...(usage ? { usage } : {}) };
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // /vision: model + show. The model picker lists vision-capable models.
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
  const m = ctx.modelRegistry.find(provider, modelId);
  if (!m) {
    ctx.ui.notify(`Model ${value} not found in the registry.`, "warning");
    return;
  }
  if (!m.input?.includes("image")) {
    ctx.ui.notify(`Model ${value} cannot process images. Pick one with image input.`, "warning");
    return;
  }
  config.provider = provider;
  config.model = modelId;
  saveConfig(config);
  ctx.ui.notify(`Vision model set to ${provider}/${modelId}.`, "info");
}
