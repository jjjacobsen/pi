// pi-lg: open lazygit full-screen over the pi TUI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capture, registerTerminalCommand } from "./lib/terminal-process";

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

export default function (pi: ExtensionAPI) {
  registerTerminalCommand(pi, {
    name: "lg",
    command: "lazygit",
    description: "Open lazygit full-screen over the pi TUI (esc to quit and return)",
    statusText: "lazygit (esc to quit)",
    installCommand: "brew install lazygit",
    prepare,
  });
}
