// Shared process handoff for full-screen terminal extensions

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";

export function capture(command, args, options = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function runOnTerminal(command, cwd, signal) {
  return new Promise<string>((resolve, reject) => {
    let tty;
    try {
      tty = openSync("/dev/tty", "r+");
    } catch {
      reject(new Error("cannot open controlling terminal /dev/tty"));
      return;
    }

    let child;
    try {
      child = spawn(command, [], { cwd, stdio: [tty, tty, tty] });
    } finally {
      closeSync(tty);
    }

    const abort = () => child.kill("SIGTERM");
    const cleanup = () => signal?.removeEventListener("abort", abort);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, childSignal) => {
      cleanup();
      if (code !== null) resolve(`exited ${code}`);
      else resolve(`signal ${constants.signals[childSignal]}`);
    });

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function notify(ctx, label, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[${label}] ${text}`, level);
  } catch {
    // Headless sessions have no UI.
  }
}

function spawnError(command, installCommand, error) {
  if (error?.code === "ENOENT") return `${command} not found in PATH (install with: ${installCommand})`;
  if (error?.code === "EACCES") return `${command} is not executable`;
  return error?.message ?? String(error);
}

export function registerTerminalCommand(pi, options) {
  pi.registerCommand(options.name, {
    description: options.description,
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return notify(ctx, options.name, "only available in the pi TUI", "warning");

      const target = path.resolve(ctx.cwd, (args ?? "").trim() || ".");
      try {
        const cwd = await options.prepare(target, ctx.signal);
        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          void (async () => {
            let outcome;
            try {
              tui.stop();
              outcome = { text: await runOnTerminal(options.command, cwd, ctx.signal) };
            } catch (error) {
              outcome = { error: spawnError(options.command, options.installCommand, error) };
            } finally {
              tui.start();
              tui.requestRender(true);
              done(null);
            }
            if (outcome?.error) {
              notify(ctx, options.name, outcome.error, "error");
            } else {
              notify(
                ctx,
                options.name,
                `${options.command} ${outcome.text}`,
                outcome.text.startsWith("exited 0") ? "info" : "warning",
              );
            }
          })();
          return new Text(theme.fg("dim", options.statusText), 1, 0);
        });
      } catch (error) {
        notify(ctx, options.name, error?.message ?? String(error), "error");
      }
    },
  });
}
