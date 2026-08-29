// pi-nvim: open neovim full-screen over the pi TUI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capture, registerTerminalCommand } from "./lib/terminal-process";

async function prepare(target, signal) {
  try {
    await capture("nvim", ["--version"], { signal });
    return target;
  } catch {
    if (signal?.aborted) throw new Error("nvim validation aborted");
    throw new Error("nvim not found in PATH (install with: brew install neovim)");
  }
}

export default function (pi: ExtensionAPI) {
  registerTerminalCommand(pi, {
    name: "nvim",
    command: "nvim",
    description: "Open neovim full-screen over the pi TUI (:q to quit and return)",
    statusText: "nvim (:q to quit)",
    installCommand: "brew install neovim",
    prepare,
  });
}
