import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resizeImage, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { discoverImageModels, imageFormat, registerImageProviders } from "./lib/image-providers";
import { modelKey, registerWorkerModel } from "./lib/worker-model";

export default function imagegenExtension(pi: ExtensionAPI) {
  registerImageProviders(pi);
  const readConfig = registerWorkerModel(pi, "image", "Image", {
    getModels: discoverImageModels,
    thinking: false,
  });

  pi.registerTool({
    name: "imagegen",
    label: "Generate image",
    description: "Generate images or edit local reference images with the model selected by /image-model. Uses separate provider billing, not Codex subscription usage. Saves original image files and returns a preview of the first image. The output path's extension is adjusted to the actual format. Existing files are not overwritten. Quality, dimensions, and style should be described in the prompt. Reference editing depends on the selected model.",
    promptSnippet: "Generate or edit images with the separately selected image model",
    promptGuidelines: ["Use imagegen when the user requests image generation or editing. Include all necessary visual instructions in its prompt, because imagegen does not receive the conversation."],
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete image instructions, including what to preserve when editing", minLength: 1 }),
      path: Type.String({ description: "Output path, relative to the project or absolute. The actual image format determines the extension", minLength: 1 }),
      references: Type.Optional(Type.Array(Type.String(), { description: "Local reference image paths to send to the selected provider" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const config = await readConfig();
      if (!config) throw new Error("Select an image model with /image-model first");
      const model = (await ctx.modelRegistry.getAvailableOfType("image", undefined, { signal }))
        .find((candidate) => modelKey(candidate) === config.model);
      if (!model) throw new Error(`Image model unavailable: ${config.model}. Run /image-model`);
      if (params.references?.length && !model.input.includes("image")) throw new Error("Selected image model does not accept reference images. Run /image-model");
      const requestSignal = AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]);
      requestSignal.throwIfAborted();
      const target = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const stem = target.slice(0, target.length - extname(target).length);
      for (const extension of ["png", "jpg", "webp", "gif"]) {
        if (existsSync(`${stem}.${extension}`)) throw new Error(`Output already exists: ${stem}.${extension}. Choose a new path`);
      }
      await mkdir(dirname(target), { recursive: true });
      const references = await Promise.all((params.references ?? []).map(async (path) => {
        const bytes = await readFile(resolve(ctx.cwd, path.replace(/^@/, "")));
        const { mimeType } = imageFormat(bytes);
        return { type: "image" as const, mimeType, data: bytes.toString("base64") };
      }));
      onUpdate?.({ content: [{ type: "text", text: `Generating with ${modelKey(model)}…` }], details: {} });
      const result = await ctx.modelRegistry.generateImages(model, {
        input: [{ type: "text", text: params.prompt }, ...references],
      }, { signal: requestSignal, maxRetries: 0 });
      const { usage } = result;
      const details = { model: modelKey(model), providerUsage: usage };
      const blocks = result.output.filter((block) => block.type === "image");
      if (result.stopReason !== "stop" || requestSignal.aborted || !blocks.length) {
        return {
          content: [{ type: "text", text: result.errorMessage ?? (requestSignal.aborted ? "Image generation cancelled or timed out" : "Image generation returned no images") }],
          details,
          isError: true,
          usage,
        };
      }
      const images = blocks.map((image) => {
        const bytes = Buffer.from(image.data, "base64");
        return { bytes, ...imageFormat(bytes) };
      });
      const paths = [];
      for (const [index, image] of images.entries()) {
        const path = `${stem}${index ? `-${index + 1}` : ""}.${image.extension}`;
        await withFileMutationQueue(path, async () => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, image.bytes, { flag: "wx" });
        });
        paths.push(path);
      }
      const preview = await resizeImage(images[0].bytes, images[0].mimeType, { maxWidth: 1024, maxHeight: 1024, maxBytes: 1_000_000 });
      const text = `Saved with ${modelKey(model)}:\n${paths.join("\n")}`
        + result.output.filter((block) => block.type === "text").map((block) => `\n${block.text}`).join("")
        + (preview ? "\nPreview only. Saved files retain the original resolution." : "\nPreview unavailable. Use read to inspect the saved image.");
      return {
        content: [
          { type: "text" as const, text },
          ...(preview ? [{ type: "image" as const, mimeType: preview.mimeType, data: preview.data }] : []),
        ],
        details: { ...details, paths },
        usage,
      };
    },
  });
}
