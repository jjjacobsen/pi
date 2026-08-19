// pi-nvim: /nvim command glue for the Zig nvim backend.
//
// Mirror of extensions/lazygit.ts: hands the whole terminal to neovim (quit
// returns to pi), built on pi's app.editor.external mechanism (tui.stop ->
// child on the terminal -> tui.start + full redraw).
//
// Thin TS: registers the /nvim command, owns the pi TUI lifecycle around the
// backend's run op, and bridges to the Zig backend (src/nvim.zig) as a
// one-shot process: each op travels as one JSON argv element via pi.exec
// (shared callZig helper), the binary prints one JSON envelope to stdout and
// exits. All process logic lives in Zig.
//
// Note: pi is not paused while nvim has the terminal. tui.stop() only
// hides the TUI frame; the agent loop keeps running behind nvim, exactly
// like Ctrl+G's external editor.
//
// Protocol:
//   pi.exec("pi-nvim", [`{"op":"prepare","cwd":"/path"}`]) -> {"ok":true,"result":"/path"}
//   pi.exec("pi-nvim", [`{"op":"run","cwd":"/path"}`])     -> {"ok":true,"result":"exited 0"}
//   failures -> {"ok":false,"error":"..."}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { callZig } from "./lib/zig";

const BIN = "pi-nvim";

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[nvim] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("nvim", {
    description: "Open neovim full-screen over the pi TUI (:q to quit and return)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return notify(ctx, "only available in the pi TUI", "warning");

      // /nvim opens in the session cwd; /nvim <path> opens at that path.
      const target = path.resolve(ctx.cwd, (args ?? "").trim() || ".");
      try {
        // Validate before the TUI stops so failures never blink the screen.
        await callZig(pi, BIN, { op: "prepare", cwd: target }, { signal: ctx.signal });

        // custom() is the only extension API that hands over the live TUI
        // reference, which is what we need for stop/start. The placeholder
        // component shows for a frame before nvim takes the terminal.
        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          void (async () => {
            let outcome;
            try {
              tui.stop();
              const res = await callZig(pi, BIN, { op: "run", cwd: target }, { signal: ctx.signal });
              outcome = { text: res.result };
            } catch (err) {
              outcome = { error: err?.message ?? String(err) };
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
      } catch (err) {
        notify(ctx, err?.message ?? String(err), "error");
      }
    },
  });
}
