import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { withBrowserPlacement } from "./browser-hyprland";

const helper = fileURLToPath(new URL("./browser.sh", import.meta.url));

export function bounded(text) {
  const result = truncateHead(text, { maxBytes: 12000, maxLines: 200 });
  return result.content + (result.truncated ? "\n[Truncated. Read a relevant element instead of the whole page.]" : "");
}

export function webUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Browser URLs must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Browser URLs must not contain credentials");
  return url.href;
}

export function actionArgs(args) {
  const { action, value } = args;
  if (args.ref !== undefined && !/^@?e[0-9]+$/.test(args.ref)) throw new Error("Browser actions require a native snapshot ref");
  const ref = args.ref && (args.ref.startsWith("@") ? args.ref : `@${args.ref}`);
  if (["click", "fill", "select", "check", "uncheck"].includes(action) && !ref) throw new Error(`${action} requires a ref`);
  if (["open", "fill", "select", "press", "scroll", "wait"].includes(action) && value === undefined) throw new Error(`${action} requires a value`);
  // Values are positional CLI arguments, never global launch options.
  if (value?.startsWith("-")) throw new Error("Browser values must not start with a CLI option prefix");
  switch (action) {
    case "open": return ["open", webUrl(value)];
    case "snapshot": return ["snapshot", "--urls"];
    case "read": return ["get", "text", ref ?? "body"];
    case "click": case "check": case "uncheck": return [action, ref];
    case "fill": case "select": return [action, ref, value];
    case "press":
      if (!["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(value)) throw new Error("Unsupported browser key");
      return ["press", value];
    case "scroll":
      if (!["up", "down"].includes(value)) throw new Error("Scroll must be up or down");
      return ["scroll", value, "500"];
    case "wait": return value === "" ? ["wait", "150"] : ["wait", "--text", value, "--timeout", "2000"];
    default: throw new Error(`Unsupported browser action: ${action}`);
  }
}

export function createBrowserClient(pi: ExtensionAPI, cwd: string, visible: boolean, signal?: AbortSignal, record?: (ms: number, snapshots: number) => void) {
  const timed = async (snapshots, execute) => {
    const start = performance.now();
    try { return await execute(); }
    finally { record?.(performance.now() - start, snapshots); }
  };
  const placed = (opens, execute) => visible && opens ? withBrowserPlacement(pi, signal, execute) : execute();
  return {
    run: (args, cleanup = false) => timed(0, () => placed(args[0] === "open", async () => {
      const result = await pi.exec("env", [`AGENT_BROWSER_HEADED=${visible}`, "bash", helper, ...args], {
        cwd, timeout: 45000, signal: cleanup ? undefined : signal,
      });
      if (result.killed || result.code !== 0) throw new Error(bounded(result.stderr || result.stdout || "Browser command interrupted"));
      return bounded(result.stdout);
    })),
    batch: (commands, allowFailure = false) => timed(commands.filter((command) => command[0] === "snapshot").length, () => placed(commands.some((command) => command[0] === "open"), async () => {
      // JSON stdin preserves exact positional values, including empty strings.
      const result = await pi.exec("bash", ["-c", 'set -o pipefail; printf "%s" "$1" | env AGENT_BROWSER_HEADED="$3" bash "$2" --json batch --bail', "browser-batch", JSON.stringify(commands), helper, String(visible)], {
        cwd, timeout: 45000, signal,
      });
      if (result.killed) throw new Error(`Browser batch interrupted; earlier actions may have run. Do not retry blindly. ${bounded(result.stderr + result.stdout)}`);
      const entries = JSON.parse(result.stdout);
      if (!allowFailure && (result.code !== 0 || entries.some((entry) => !entry.success))) throw new Error(`Browser batch failed; earlier actions may have run. Do not retry blindly. ${bounded(result.stderr + result.stdout)}`);
      return entries;
    })),
    info: () => timed(0, async () => {
      // Native session diagnostics do not start a browser or alter launch settings.
      const result = await pi.exec("agent-browser", ["--session", "browser", "session", "info", "--json"], { cwd, timeout: 9000, signal });
      if (result.killed || result.code !== 0) throw new Error("Cannot inspect browser ownership");
      const entry = JSON.parse(result.stdout);
      if (!entry.success || typeof entry.data.active !== "boolean" || (entry.data.active && !Number.isInteger(entry.data.pid))) throw new Error("Invalid browser ownership response");
      return { active: entry.data.active, pid: entry.data.pid };
    }),
  };
}
