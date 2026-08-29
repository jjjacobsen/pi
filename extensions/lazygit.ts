// pi-lg: open lazygit full-screen over the pi TUI
//
// Validation runs before the TUI stops. The child then owns /dev/tty until
// it exits, after which pi restores and fully redraws its TUI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import path from "node:path";
import { capture, runOnTerminal } from "./lib/terminal-process";

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[lg] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

async function prepare(cwd, signal) {
  try {
    await capture("lazygit", ["--version"], { signal });
  } catch {
    if (signal?.aborted) throw new Error("lazygit validation aborted");
    throw new Error("lazygit not found in PATH (install with: brew install lazygit)");
  }

  try {
    const root = await capture("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { signal });
    if (!root.trim()) throw new Error("empty git root");
    return root.trim();
  } catch {
    if (signal?.aborted) throw new Error("lazygit validation aborted");
    throw new Error("not a git repository");
  }
}

function spawnError(error) {
  if (error?.code === "ENOENT") return "lazygit not found in PATH (install with: brew install lazygit)";
  if (error?.code === "EACCES") return "lazygit is not executable";
  return error?.message ?? String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lg", {
    description: "Open lazygit full-screen over the pi TUI (esc to quit and return)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return notify(ctx, "only available in the pi TUI", "warning");

      const target = path.resolve(ctx.cwd, (args ?? "").trim() || ".");
      try {
        const root = await prepare(target, ctx.signal);

        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          void (async () => {
            let outcome;
            try {
              tui.stop();
              outcome = { text: await runOnTerminal("lazygit", root, ctx.signal) };
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
              notify(ctx, `lazygit ${outcome.text}`, outcome.text.startsWith("exited 0") ? "info" : "warning");
            }
          })();
          return new Text(theme.fg("dim", "lazygit (esc to quit)"), 1, 0);
        });
      } catch (error) {
        notify(ctx, error?.message ?? String(error), "error");
      }
    },
  });
}
