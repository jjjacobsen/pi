// pi-nvim: open neovim full-screen over the pi TUI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTerminalCommand } from "./lib/terminal-process";

export default function (pi: ExtensionAPI) {
  registerTerminalCommand(pi, {
    name: "nvim",
    command: "nvim",
    description: "Open neovim full-screen over the pi TUI (:q to quit and return)",
    statusText: "nvim (:q to quit)",
    installCommand: "brew install neovim",
  });
}
