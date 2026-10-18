import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, open, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, extname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserCommandArgs, type createBrowserHandle } from "./browser-runtime";

export interface BrowserArtifactClient {
  // The caller scopes commands to its owned browser and binds the operation signal.
  // cleanup=true must ignore an expired operation signal and still check failures.
  run(args: string[], cleanup?: boolean): Promise<string>;
}

// Native command contracts: https://github.com/vercel-labs/agent-browser/tree/v0.39.1
export async function startRecording(client: BrowserArtifactClient, path: string, signal?: AbortSignal) {
  if (!isAbsolute(path)) throw new Error("Recording path must be absolute");
  if (![".mp4", ".webm"].includes(extname(path).toLowerCase())) throw new Error("Recording requires an .mp4 or .webm path");
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  // ffmpeg uses -y. Reserve a new private file before letting it write, never an
  // existing file or symlink. Keep the reservation on failure, since capture may
  // have started even when the CLI failed. The caller must use a new path to retry.
  const file = await open(path, "wx", 0o600);
  await file.close();
  signal?.throwIfAborted();
  await client.run(["record", "start", path]);
  return path;
}

export function stopRecording(client: BrowserArtifactClient) {
  // Native record stop waits for capture and ffmpeg to flush. Call before close,
  // including after an uncertain start. Do not use the cancelled turn's signal.
  return client.run(["record", "stop"], true);
}

export interface BrowserDashboard {
  readonly handle: ReturnType<typeof createBrowserHandle>;
  readonly namespace: string;
  readonly sessionName: string;
  readonly port: number;
  readonly pid: number;
  readonly url: string;
  readonly socketDir: string;
}

// Runtime-only ownership. Never reconstruct this map from transcript entries.
const dashboards = new Map<string, Promise<BrowserDashboard>>();
type DashboardContext = Pick<ExtensionContext, "hasUI" | "cwd">;
type DashboardOwner = ReturnType<typeof createBrowserHandle>;

async function dashboardCommand(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd">, owner: DashboardOwner, args: string[]) {
  const result = await pi.exec("bash", [...browserCommandArgs(owner), "--json", ...args], { cwd: ctx.cwd, timeout: 10000 });
  // Do not copy CLI output into errors. It can include capability URLs.
  if (result.killed || result.code !== 0) throw new Error("Browser dashboard command failed");
  const entry = JSON.parse(result.stdout);
  if (!entry.success) throw new Error("Browser dashboard command failed");
  return entry.data;
}

async function availableDashboardPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function dashboardPid(dashboard: BrowserDashboard) {
  try {
    return Number((await readFile(join(dashboard.socketDir, "dashboard.pid"), "utf8")).trim());
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function stopOwnedDashboard(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd">, dashboard: BrowserDashboard) {
  const pid = await dashboardPid(dashboard);
  if (pid === undefined) return;
  const config = JSON.parse(await readFile(join(dashboard.socketDir, "dashboard.config"), "utf8"));
  if (pid !== dashboard.pid || config.port !== dashboard.port) throw new Error("Browser dashboard ownership changed. No stop command was sent");
  await dashboardCommand(pi, ctx, dashboard.handle, ["dashboard", "stop"]);
}

async function startDashboard(pi: ExtensionAPI, ctx: DashboardContext, owner: DashboardOwner) {
  const info = await dashboardCommand(pi, ctx, owner, ["session", "info"]);
  if (info.namespace !== owner.namespace || info.session !== owner.sessionName) throw new Error("Browser dashboard namespace does not match its owner");
  // v0.39.1 accepts --port 1..65535, not --port 0 or --host. Its server binds
  // only 127.0.0.1 and ::1. Reserve an OS-selected port, then release for start.
  // Another process can win that short race, so startup must check readiness.
  const port = await availableDashboardPort();
  const started = await dashboardCommand(pi, ctx, owner, ["dashboard", "start", "--port", String(port)]);
  if (started.already_running) throw new Error("An unowned dashboard already exists in this namespace. No stop command was sent");
  if (started.port !== port || !Number.isInteger(started.pid) || started.pid <= 0) throw new Error("Invalid browser dashboard start response");
  const dashboard: BrowserDashboard = Object.freeze({ handle: owner, namespace: owner.namespace, sessionName: owner.sessionName, port, pid: started.pid, url: `http://127.0.0.1:${port}/`, socketDir: info.socketDir });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await dashboardPid(dashboard) !== dashboard.pid) throw new Error("Browser dashboard ownership changed during startup");
      process.kill(dashboard.pid, 0);
      const response = await fetch(`${dashboard.url}api/sessions`, {
        headers: { Origin: new URL(dashboard.url).origin }, signal: AbortSignal.timeout(500),
      }).catch(() => undefined);
      if (response) {
        if (!response.ok || !Array.isArray(await response.json())) throw new Error("Browser dashboard readiness check failed");
        return dashboard;
      }
      await delay(100);
    }
    throw new Error("Browser dashboard did not become ready");
  } catch (error) {
    await stopOwnedDashboard(pi, ctx, dashboard);
    throw error;
  }
}

/**
 * Open the stock trusted-local UI for an owner-unique browser namespace.
 * All commands and /api/exec children share browser.sh's headless launch settings.
 * The caller must launch its browser in this same namespace. Namespace scopes
 * default discovery, NOT authorization. Stock loopback access bypasses tokens,
 * and /api/exec can select other namespaces. This is not a security sandbox
 * against the same OS user. Never proxy or expose this dashboard to a network.
 * Source: https://github.com/vercel-labs/agent-browser/tree/v0.39.1/cli/src/native/stream
 */
export async function openDashboard(pi: ExtensionAPI, ctx: DashboardContext, owner: DashboardOwner) {
  if (!ctx.hasUI) throw new Error("Manual browser login requires an interactive UI");
  if (!/^pi-[a-f0-9]{16}$/.test(owner.namespace) || !/^pi-[a-f0-9]{12}$/.test(owner.sessionName)) throw new Error("Browser dashboard requires an owner-unique pi namespace and session");
  let pending = dashboards.get(owner.namespace);
  if (!pending) {
    pending = startDashboard(pi, ctx, owner);
    dashboards.set(owner.namespace, pending);
  }
  const dashboard = await pending.catch((error) => { dashboards.delete(owner.namespace); throw error; });
  if (dashboard.handle !== owner) throw new Error("Browser dashboard belongs to another handle");
  try {
    const [command, args] = process.platform === "darwin" ? ["open", [dashboard.url]]
      : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", dashboard.url]]
        : ["xdg-open", [dashboard.url]];
    const opened = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 10000 });
    if (opened.killed || opened.code !== 0) throw new Error("Could not open the local browser dashboard");
    return dashboard;
  } catch (error) {
    // A failed opener must not leave an unreachable dashboard running.
    await closeDashboard(pi, ctx, owner);
    throw error;
  }
}

// Namespace-scoped and idempotent. Only stop a dashboard started by this module.
export async function closeDashboard(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd">, owner: Pick<BrowserDashboard, "namespace">) {
  const pending = dashboards.get(owner.namespace);
  if (!pending) return;
  let dashboard: BrowserDashboard;
  try { dashboard = await pending; }
  catch { dashboards.delete(owner.namespace); return; }
  await stopOwnedDashboard(pi, ctx, dashboard);
  dashboards.delete(owner.namespace);
}
