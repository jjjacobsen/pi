// pi-lg: /lg command glue for the Zig lazygit backend.
//
// Modeled on kdheepak/lazygit.nvim's UX (full-screen lazygit over the
// editor; quit returns to the editor) and on pi's built-in app.editor.external
// mechanism (tui.stop -> child on the terminal -> tui.start + full redraw).
//
// Thin TS: registers the /lg command, owns the pi TUI lifecycle around the
// backend's run op, and bridges to the Zig backend (src/lazygit.zig) over a
// newline-delimited JSON pipe. All process logic lives in Zig.
//
// Protocol (one JSON object per line):
//   -> {"id":1,"op":"prepare","cwd":"/path"}  <- {"id":1,"ok":true,"result":"<repo-root>"}
//   -> {"id":2,"op":"run","cwd":"/path"}      <- {"id":2,"ok":true,"result":"exited 0"}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { createBackend } from "./lib/backend";

const backend = createBackend("pi-lg");
function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[lg] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lg", {
    description: "Open lazygit full-screen over the pi TUI (esc to quit and return)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return notify(ctx, "only available in the pi TUI", "warning");

      // /lg opens in the session cwd; /lg <path> opens at that path.
      const target = path.resolve(ctx.cwd, (args ?? "").trim() || ".");
      try {
        // Validate before the TUI stops so failures never blink the screen.
        await backend.call("prepare", { cwd: target });

        // custom() is the only extension API that hands over the live TUI
        // reference, which is what we need for stop/start. The placeholder
        // component shows for a frame before lazygit takes the terminal.
        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          void (async () => {
            let outcome;
            try {
              tui.stop();
              outcome = await backend.call("run", { cwd: target });
            } catch (err) {
              outcome = { error: err?.message ?? String(err) };
            } finally {
              tui.start();
              tui.requestRender(true);
              done();
            }
            if (outcome?.error) {
              notify(ctx, outcome.error, "error");
            } else {
              notify(ctx, `lazygit ${outcome.result}`, outcome.result.startsWith("exited 0") ? "info" : "warning");
            }
          })();
          return new Text(theme.fg("dim", "lazygit (esc to quit)"), 1, 0);
        });
      } catch (err) {
        notify(ctx, err?.message ?? String(err), "error");
      }
    },
  });
}
