import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, resizeImage, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { discoverImageModels, generateImages, imageFormat, modelKey, type ImageModel } from "./lib/image-providers";

const configPath = () => join(getAgentDir(), "imagegen.json");

async function selectedModel(): Promise<ImageModel | undefined> {
  const path = configPath();
  return existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : undefined;
}

// Uses pi's Input and SelectList, following the selection pattern in pi's TUI docs
function modelPicker(tui, theme, keybindings, done, models: ImageModel[], current?: ImageModel) {
  const input = new Input();
  const items = models.map((model) => ({ value: modelKey(model), label: modelKey(model) }));
  const listTheme = {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
  const createList = (filtered) => {
    const list = new SelectList(filtered, 12, listTheme);
    list.onSelect = (item) => done(models.find((model) => modelKey(model) === item.value));
    list.onCancel = () => done(undefined);
    return list;
  };
  let list = createList(items);
  if (current) list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === modelKey(current))));
  return {
    get focused() { return input.focused; },
    set focused(value) { input.focused = value; },
    render(width) {
      return [
        ...new Text(theme.fg("accent", "Image model (saved for all sessions)"), 0, 0).render(width),
        ...input.render(width),
        ...list.render(width),
        ...new Text(theme.fg("dim", "Type to filter · arrows to move · Enter to save · Esc to cancel"), 0, 0).render(width),
      ];
    },
    invalidate() { input.invalidate(); list.invalidate(); },
    handleInput(data) {
      if (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"].some((key) => keybindings.matches(data, key))) {
        list.handleInput(data);
      } else {
        input.handleInput(data);
        list = createList(fuzzyFilter(items, input.getValue(), (item) => item.value));
      }
      tui.requestRender();
    },
  };
}

export default function imagegenExtension(pi: ExtensionAPI) {
  pi.registerCommand("image-model", {
    description: "Select an image model from OpenRouter or Vercel AI Gateway (separate from the coding model)",
    handler: async (args, ctx) => {
      const models = await discoverImageModels(ctx);
      let model: ImageModel;
      if (args.trim()) {
        model = models.find((candidate) => modelKey(candidate) === args.trim());
        if (!model) throw new Error("Image model not found. Run /image-model to choose an exact provider/model");
      } else {
        if (ctx.mode !== "tui") throw new Error("Use /image-model provider/model outside the TUI");
        const current = await selectedModel();
        model = await ctx.ui.custom<ImageModel>((tui, theme, keys, done) => modelPicker(tui, theme, keys, done, models, current));
      }
      if (!model) return;
      await withFileMutationQueue(configPath(), async () => {
        await mkdir(getAgentDir(), { recursive: true });
        await writeFile(configPath(), `${JSON.stringify(model, null, 2)}\n`);
      });
      ctx.ui.notify(`Image model: ${modelKey(model)}`, "info");
    },
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
      const model = await selectedModel();
      if (!model) throw new Error("Select an image model with /image-model first");
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
        return `data:${mimeType};base64,${bytes.toString("base64")}`;
      }));
      onUpdate?.({ content: [{ type: "text", text: `Generating with ${modelKey(model)}…` }], details: {} });
      const { images, usage, warnings } = await generateImages(ctx, model, params.prompt, references, requestSignal);
      requestSignal.throwIfAborted();
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
        + (warnings?.length ? `\nProvider warnings: ${JSON.stringify(warnings).slice(0, 2000)}` : "")
        + (preview ? "\nPreview only. Saved files retain the original resolution." : "\nPreview unavailable. Use read to inspect the saved image.");
      return {
        content: [
          { type: "text" as const, text },
          ...(preview ? [{ type: "image" as const, mimeType: preview.mimeType, data: preview.data }] : []),
        ],
        details: { paths, model: modelKey(model), providerUsage: usage },
        ...(usage?.cost !== undefined ? { usage: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
          cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: usage.cost, cacheRead: 0, cacheWrite: 0, total: usage.cost },
        } } : {}),
      };
    },
  });
}
