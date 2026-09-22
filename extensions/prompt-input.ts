import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("input", (event) => {
    if (event.source === "extension") return;

    const match = event.text.match(/^\/(goal|handoff|implement|q)(?:\r\n|\s)([\s\S]*)$/);
    if (!match) return;

    const [, name, input] = match;
    const command = pi.getCommands().find((command) => command.name === name);
    const path = fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url));
    if (command?.source !== "prompt" || command.sourceInfo.path !== path) return;

    // Keep the text as one argument for pi's quote-aware template parser.
    return {
      action: "transform",
      text: `/${name} '${input.replaceAll("'", "'\"'\"'")}'`,
    };
  });
}
