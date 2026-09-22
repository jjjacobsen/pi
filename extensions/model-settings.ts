import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modelKey, readWorkerModel } from "./lib/worker-model";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("model-settings", {
    description: "Show global pi defaults and model and thinking settings for workers",
    handler: async (_args, ctx) => {
      const models = ctx.modelRegistry.getAvailable();
      const settings = SettingsManager.create(ctx.cwd).getGlobalSettings();
      const defaultModel = settings.defaultModel
        ? `${settings.defaultProvider ? `${settings.defaultProvider}/` : ""}${settings.defaultModel} (saved)`
        : "not set";
      const rows = [
        ["Scope", "Model", "Thinking"],
        ["pi default", defaultModel, settings.defaultThinkingLevel ? `${settings.defaultThinkingLevel} (saved)` : "not set"],
      ];
      for (const name of ["subagent", "browser", "commit"]) {
        const config = await readWorkerModel(name);
        if (!config && name === "browser") {
          rows.push([name, "not set (use /browser-model)", "not set"]);
          continue;
        }
        const model = config
          ? models.find((candidate) => modelKey(candidate) === config.model)
          : ctx.model;
        const modelText = config
          ? `${config.model} (saved${model ? "" : ", unavailable"})`
          : `${model ? modelKey(model) : "none"} (inherited)`;
        const thinking = config?.thinking ?? (name === "subagent" ? ctx.thinkingLevel : name === "commit" ? "low" : "off");
        const source = config?.thinking !== undefined ? "saved" : name === "subagent" ? "inherited" : "default";
        const effective = model ? clampThinkingLevel(model, thinking) : undefined;
        const thinkingText = effective === undefined
          ? `${thinking} (${source}, model unavailable)`
          : effective === thinking ? `${thinking} (${source})` : `${effective} (${source}: ${thinking}, clamped)`;
        rows.push([name, modelText, thinkingText]);
      }
      const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
      ctx.ui.notify(rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n"), "info");
    },
  });
}
