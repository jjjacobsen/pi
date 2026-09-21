// Provider protocols: see docs/imagegen.md for the official API references
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const IMAGE_PROVIDERS = ["openrouter", "vercel-ai-gateway"];

export type ImageModel = {
  provider: string;
  id: string;
  api: "images" | "chat";
};

export function modelKey(model: ImageModel) {
  return `${model.provider}/${model.id}`;
}

async function connection(ctx: ExtensionContext, provider: string) {
  if (!IMAGE_PROVIDERS.includes(provider)) throw new Error(`Unsupported image provider: ${provider}`);
  const resolved = await ctx.modelRegistry.getProviderAuth(provider);
  if (!resolved?.auth.apiKey) throw new Error(`Run /login ${provider} before using imagegen`);
  const auth = resolved.auth;
  let baseUrl = (auth.baseUrl ?? ctx.modelRegistry.getProvider(provider).baseUrl).replace(/\/$/, "");
  if (provider === "vercel-ai-gateway" && !baseUrl.endsWith("/v1")) baseUrl += "/v1";
  const headers = new Headers({ Authorization: `Bearer ${auth.apiKey}`, "Content-Type": "application/json" });
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return { baseUrl, headers };
}

async function request(connection, path, signal, body?) {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: connection.headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Image API HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  const result = await response.json();
  if (result.error) throw new Error(`Image API: ${JSON.stringify(result.error).slice(0, 2000)}`);
  return result;
}

export async function discoverImageModels(ctx: ExtensionContext) {
  const providers = IMAGE_PROVIDERS.filter((id) => ctx.modelRegistry.getProviderAuthStatus(id).configured);
  if (!providers.length) throw new Error("Run /login openrouter or /login vercel-ai-gateway first");
  const results = await Promise.allSettled(providers.map(async (provider) => {
    const conn = await connection(ctx, provider);
    const { data } = await request(conn, provider === "openrouter" ? "/images/models" : "/models", AbortSignal.timeout(30_000));
    return data
      .filter((m) => (provider === "openrouter" ? m.architecture?.output_modalities : m.modalities?.output)?.includes("image"))
      .map((m) => ({
        provider,
        id: m.id,
        api: provider === "vercel-ai-gateway" && m.type !== "image" ? "chat" : "images",
      } as ImageModel));
  }));
  const models: ImageModel[] = [];
  const errors = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") models.push(...result.value);
    else errors.push(`${providers[i]}: ${result.reason.message}`);
  });
  if (!models.length) throw new Error(errors.join("\n") || "No image-output models found");
  if (errors.length) ctx.ui.notify(errors.join("\n"), "warning");
  return models.sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

export function imageFormat(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mimeType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return { extension: "gif", mimeType: "image/gif" };
  throw new Error("Image API returned an unsupported image format (expected PNG, JPEG, WebP, or GIF)");
}

export async function generateImages(ctx: ExtensionContext, model: ImageModel, prompt: string, references: string[], signal: AbortSignal) {
  const conn = await connection(ctx, model.provider);
  let path;
  let body;
  if (model.provider === "openrouter") {
    path = "/images";
    body = {
      model: model.id, prompt, n: 1,
      ...(references.length ? { input_references: references.map((url) => ({ type: "image_url", image_url: { url } })) } : {}),
    };
  } else if (model.api === "chat") {
    path = "/chat/completions";
    body = {
      model: model.id,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        ...references.map((url) => ({ type: "image_url", image_url: { url } })),
      ] }],
      modalities: ["text", "image"],
      stream: false,
    };
  } else {
    path = references.length ? "/images/edits" : "/images/generations";
    body = {
      model: model.id, prompt, n: 1, response_format: "b64_json",
      ...(references.length ? { images: references.map((image_url) => ({ image_url })) } : {}),
    };
  }
  const result = await request(conn, path, signal, body);
  const encoded = model.api === "chat"
    ? result.choices?.flatMap((choice) => (choice.message.images ?? []).map((image) => {
        const match = /^data:image\/[\w.+-]+;base64,([\s\S]+)$/.exec(image.image_url.url);
        if (!match) throw new Error("Image API did not return a base64 image");
        return match[1];
      }))
    : result.data?.map((image) => image.b64_json);
  if (!encoded?.length) throw new Error("Image API returned no images");
  const images = encoded.map((data) => {
    const bytes = Buffer.from(data, "base64");
    return { bytes, ...imageFormat(bytes) };
  });
  return { images, usage: result.usage, warnings: result.warnings };
}
