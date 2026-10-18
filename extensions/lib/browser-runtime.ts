import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// Never restore this identity from a transcript. Two resumed copies need distinct owners.
export function createBrowserHandle(piSessionId: string) {
  const owner = randomBytes(8).toString("hex");
  const sessionName = `pi-${createHash("sha256").update(piSessionId).digest("hex").slice(0, 12)}`;
  const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH || execFileSync("bash", ["-c", "command -v chromium || command -v chromium-browser"], { encoding: "utf8", timeout: 1000 }).trim();
  const configDir = mkdtempSync(join(tmpdir(), "pi-browser-"));
  const configPath = join(configDir, "config.json");
  try { writeFileSync(configPath, "{}", { mode: 0o600 }); }
  catch (error) { rmSync(configDir, { recursive: true, force: true }); throw error; }
  return Object.freeze({ piSessionId, owner, namespace: `pi-${owner}`, sessionName, executablePath, configPath });
}

export function removeBrowserConfiguration(handle: ReturnType<typeof createBrowserHandle>) {
  rmSync(dirname(handle.configPath), { recursive: true, force: true });
}

// Both browser commands and the dashboard use browser.sh's fixed headless environment.
// The dashboard's /api/exec children inherit it, including the durable empty config.
export function browserCommandArgs(handle: ReturnType<typeof createBrowserHandle>) {
  return [helper, handle.namespace, handle.sessionName, handle.executablePath, handle.configPath];
}

export function createBrowserClient(pi: ExtensionAPI, cwd: string, handle: ReturnType<typeof createBrowserHandle>, signal?: AbortSignal, record?: (ms: number, snapshots: number) => void) {
  const timed = async (snapshots, execute) => {
    const start = performance.now();
    try { return await execute(); }
    finally { record?.(performance.now() - start, snapshots); }
  };
  const helperArgs = browserCommandArgs(handle);
  return {
    handle,
    run: (args, cleanup = false) => timed(0, async () => {
      const result = await pi.exec("bash", [...helperArgs, ...args], {
        cwd, timeout: 45000, signal: cleanup ? undefined : signal,
      });
      if (result.killed || result.code !== 0) throw new Error(bounded(result.stderr || result.stdout || "Browser command interrupted"));
      return bounded(result.stdout);
    }),
    batch: (commands, allowFailure = false) => timed(commands.filter((command) => command[0] === "snapshot").length, async () => {
      // JSON stdin preserves exact positional values, including empty strings.
      const result = await pi.exec("bash", ["-c", 'set -o pipefail; printf "%s" "$1" | bash "${@:2}" --json batch --bail', "browser-batch", JSON.stringify(commands), ...helperArgs], {
        cwd, timeout: 45000, signal,
      });
      if (result.killed) throw new Error(`Browser batch interrupted; earlier actions may have run. Do not retry blindly. ${bounded(result.stderr + result.stdout)}`);
      const entries = JSON.parse(result.stdout);
      if (!allowFailure && (result.code !== 0 || entries.some((entry) => !entry.success))) throw new Error(`Browser batch failed; earlier actions may have run. Do not retry blindly. ${bounded(result.stderr + result.stdout)}`);
      return entries;
    }),
    info: () => timed(0, async () => {
      // Native session diagnostics do not start a browser or alter launch settings.
      const result = await pi.exec("bash", [...helperArgs, "session", "info", "--json"], { cwd, timeout: 9000, signal });
      if (result.killed || result.code !== 0) throw new Error("Cannot inspect browser ownership");
      const entry = JSON.parse(result.stdout);
      if (!entry.success || entry.data.namespace !== handle.namespace || entry.data.session !== handle.sessionName || typeof entry.data.active !== "boolean" || (entry.data.active && (!Number.isInteger(entry.data.pid) || entry.data.pid <= 0))) throw new Error("Invalid browser ownership response");
      return { ...handle, active: entry.data.active, pid: entry.data.pid };
    }),
  };
}
