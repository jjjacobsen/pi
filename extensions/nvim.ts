// pi-nvim: open neovim full-screen over the pi TUI
//
// Validation runs before the TUI stops. The child then owns /dev/tty until
// it exits, after which pi restores and fully redraws its TUI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import { capture, runOnTerminal } from "./lib/terminal-process";

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[nvim] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

async function prepare(signal) {
  try {
    await capture("nvim", ["--version"], { signal });
  } catch {
    if (signal?.aborted) throw new Error("nvim validation aborted");
    throw new Error("nvim not found in PATH (install with: brew install neovim)");
  }
}

function spawnError(error) {
  if (error?.code === "ENOENT") return "nvim not found in PATH (install with: brew install neovim)";
  if (error?.code === "EACCES") return "nvim is not executable";
  return error?.message ?? String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("nvim", {
    description: "Open neovim full-screen over the pi TUI (:q to quit and return)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return notify(ctx, "only available in the pi TUI", "warning");

      const target = path.resolve(ctx.cwd, (args ?? "").trim() || ".");
      try {
        await prepare(ctx.signal);

        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          void (async () => {
            let outcome;
            try {
              tui.stop();
              outcome = { text: await runOnTerminal("nvim", target, ctx.signal) };
            } catch (error) {
              outcome = { error: spawnError(error) };
            } finally {
              tui.start();
              tui.requestRender(true);
              done(null);
            }
            if (outcome?.error) {
              notify(ctx, outcome.error, "error");
            } else {
              notify(ctx, `nvim ${outcome.text}`, outcome.text.startsWith("exited 0") ? "info" : "warning");
            }
          })();
          return new Text(theme.fg("dim", "nvim (:q to quit)"), 1, 0);
        });
      } catch (error) {
        notify(ctx, error?.message ?? String(error), "error");
      }
    },
  });
}
