import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workerPicker } from "./worker-picker";

export const modelKey = (model) => `${model.provider}/${model.id}`;

const workerConfigPath = (name: string) => join(getAgentDir(), `${name}-model.json`);

export async function readWorkerModel(name: string) {
  const path = workerConfigPath(name);
  return existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : undefined;
}

export function registerWorkerModel(pi: ExtensionAPI, name: string, label: string, {
  getModels = async (ctx) => ctx.modelRegistry.getAvailable(),
  getThinkingLevels = (model): string[] => getSupportedThinkingLevels(model),
  normalizeThinking = (model, thinking): string => clampThinkingLevel(model, thinking),
  defaultThinking = "off",
  modelConfig = (_model) => ({}),
} = {}) {
  const configPath = () => workerConfigPath(name);
  const readConfig = () => readWorkerModel(name);
  const writeConfig = async (config) => {
    await mkdir(getAgentDir(), { recursive: true });
    await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`);
  };

  pi.registerCommand(`${name}-model`, {
    description: `Select the ${name} model, separate from the main session model`,
    handler: async (args, ctx) => {
      const models = await getModels(ctx);
      let key = args.trim();
      if (!key) {
        if (ctx.mode !== "tui") throw new Error(`Use /${name}-model provider/model outside the TUI`);
        const current = await readConfig();
        key = await ctx.ui.custom<string>((tui, theme, keys, done) =>
          workerPicker(tui, theme, keys, done, `${label} model (saved for all sessions)`, models.map(modelKey), current?.model));
        if (!key) return;
      }
      const model = models.find((model) => modelKey(model) === key);
      if (!model) throw new Error(`Model unavailable. Use /${name}-model to select an exact provider/model`);
      const thinking = await withFileMutationQueue(configPath(), async () => {
        const current = await readConfig();
        const thinking = normalizeThinking(model, current?.thinking ?? defaultThinking);
        await writeConfig({ ...current, ...modelConfig(model), model: key, thinking });
        return thinking;
      });
      ctx.ui.notify(`${label}: ${key} · thinking: ${thinking}`, "info");
    },
  });

  pi.registerCommand(`${name}-thinking`, {
    description: `Select thinking for the ${name}, separate from the main session`,
    handler: async (args, ctx) => {
      const config = await readConfig();
      if (!config) throw new Error(`Select a model with /${name}-model first`);
      const model = (await getModels(ctx)).find((candidate) => modelKey(candidate) === config.model);
      if (!model) throw new Error(`${label} model unavailable: ${config.model}. Run /${name}-model`);
      const levels = getThinkingLevels(model);
      let thinking = args.trim();
      if (!thinking) {
        if (ctx.mode !== "tui") throw new Error(`Use /${name}-thinking level outside the TUI`);
        thinking = await ctx.ui.custom<string>((tui, theme, keys, done) =>
          workerPicker(tui, theme, keys, done, `${label} thinking: ${config.model}`, levels, normalizeThinking(model, config.thinking ?? defaultThinking)));
        if (!thinking) return;
      }
      if (!levels.some((level) => level === thinking)) throw new Error(`Supported ${name} thinking levels: ${levels.join(", ")}`);
      await withFileMutationQueue(configPath(), async () => {
        const current = await readConfig();
        if (current.model !== config.model) throw new Error(`${label} model changed. Run /${name}-thinking again`);
        await writeConfig({ ...current, ...modelConfig(model), thinking });
      });
      ctx.ui.notify(`${label}: ${config.model} · thinking: ${thinking}`, "info");
    },
  });

  return readConfig;
}
