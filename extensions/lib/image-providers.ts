import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { modelKey } from "./worker-model";

export function registerImageProviders(pi: ExtensionAPI) {
  const nativeOpenRouter = builtinProviders().find((provider) => provider.id === "openrouter");
  // Pi 1.3.0 sends image-only models to Chat Completions, which rejects them.
  // Protocol: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
  pi.registerProvider("openrouter", {
    images: {
      "openrouter-images": {
        async generateImages(model, context, options) {
          if (model.output.includes("text")) return nativeOpenRouter.generateImages(model, context, options);
          if (!options?.apiKey) throw new Error("No API key for provider: openrouter");
          const references = context.input.filter((block) => block.type === "image");
          const payload = {
            model: model.id,
            prompt: context.input.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
            n: 1,
            ...(references.length ? { input_references: references.map((image) => ({
              type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` },
            })) } : {}),
          };
          const body = await options.onPayload?.(payload, model) ?? payload;
          const headers = new Headers({ Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" });
          for (const [key, value] of Object.entries({ ...model.headers, ...options.headers })) {
            if (value === null) headers.delete(key);
            else headers.set(key, value);
          }
          const response = await (options.fetch ?? fetch)(`${model.baseUrl.replace(/\/+$/, "")}/images`, {
            method: "POST", headers, body: JSON.stringify(body), signal: options.signal, redirect: "error",
          });
          await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
          if (!response.ok) throw new Error(`Image API HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
          const result = await response.json();
          if (result.error) throw new Error(`Image API: ${JSON.stringify(result.error).slice(0, 2000)}`);
          const raw = result.usage;
          const usage = raw ? {
            input: raw.prompt_tokens ?? 0, output: raw.completion_tokens ?? 0,
            totalTokens: raw.total_tokens ?? (raw.prompt_tokens ?? 0) + (raw.completion_tokens ?? 0),
            cacheRead: 0, cacheWrite: 0,
            cost: { input: 0, output: raw.cost ?? 0, cacheRead: 0, cacheWrite: 0, total: raw.cost ?? 0 },
          } : undefined;
          return {
            api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            stopReason: "stop",
            output: result.data.map((image) => ({
              type: "image", data: image.b64_json,
              mimeType: imageFormat(Buffer.from(image.b64_json, "base64")).mimeType,
            })),
            usage,
          };
        },
      },
    },
  });
}

export async function discoverImageModels(ctx: ExtensionContext) {
  const models = await ctx.modelRegistry.getAvailableOfType("image", undefined, { signal: ctx.signal });
  if (!models.length) throw new Error("No image models available. Configure an image provider with /login");
  return [...models].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

export function imageFormat(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mimeType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return { extension: "gif", mimeType: "image/gif" };
  throw new Error("Unsupported image format (expected PNG, JPEG, WebP, or GIF)");
}
