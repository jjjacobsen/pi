import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./browser.sh", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Native CLI and dashboard: https://github.com/vercel-labs/agent-browser
export function createBrowserRuntime(pi: ExtensionAPI) {
  let handle;
  let dashboard;
  let viewing;
  let closing;

  async function run(owner, args: string[]) {
    const result = await pi.exec("bash", [helper, ...owner.args, "--json", ...args], { cwd: owner.cwd, timeout: 45000 });
    if (result.killed || result.code !== 0) throw new Error(result.stderr || result.stdout || "Browser command interrupted");
    const response = JSON.parse(result.stdout);
    if (!response.success) throw new Error(response.error);
    return response.data;
  }

  function get(ctx: ExtensionContext) {
    if (closing) throw new Error("Browser is closing");
    const sessionId = ctx.sessionManager.getSessionId();
    if (handle && handle.sessionId !== sessionId) throw new Error("Browser belongs to another Pi session");
    if (!handle) {
      // A fresh runtime owner also isolates two processes that resume the same Pi session.
      const namespace = `pi-${randomBytes(8).toString("hex")}`;
      const session = `pi-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
      const executable = process.env.AGENT_BROWSER_EXECUTABLE_PATH || execFileSync("bash", ["-c", "command -v chromium || command -v chromium-browser"], { encoding: "utf8", timeout: 1000 }).trim();
      const directory = mkdtempSync(join(tmpdir(), "pi-browser-"));
      const config = join(directory, "config.json");
      writeFileSync(config, "{}", { mode: 0o600 });
      handle = { sessionId, cwd: ctx.cwd, directory, args: [namespace, session, executable, config] };
    }
    return handle;
  }

  return {
    // Every worker bash call gets this function. Dashboard children inherit the
    // same settings from browser.sh, including the empty configuration file.
    commandPrefix(ctx: ExtensionContext) {
      const owner = get(ctx);
      return `agent-browser() { command bash ${[helper, ...owner.args].map(quote).join(" ")} "$@"; }\nexport -f agent-browser`;
    },
    async dashboard() {
      if (closing) throw new Error("Browser is closing");
      if (!handle) return;
      viewing ??= (async () => {
        const owner = handle;
        if (!(await run(owner, ["session", "info"])).active) return;
        if (!dashboard) {
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const port = (server.address() as AddressInfo).port;
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          const started = await run(owner, ["dashboard", "start", "--port", String(port)]);
          dashboard = `http://127.0.0.1:${started.port}/`;
        }
        const [command, args] = process.platform === "darwin" ? ["open", [dashboard]]
          : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", dashboard]]
            : ["xdg-open", [dashboard]];
        const opened = await pi.exec(command, args, { cwd: owner.cwd, timeout: 10000 });
        if (opened.killed || opened.code !== 0) throw new Error("Could not open the browser dashboard");
        return dashboard;
      })().finally(() => { viewing = undefined; });
      return viewing;
    },
    async close() {
      if (closing) return closing;
      if (!handle) return;
      const owner = handle;
      closing = (async () => {
        // A failed dashboard opener must not prevent browser cleanup.
        await viewing?.catch(() => undefined);
        try {
          if (dashboard) {
            await run(owner, ["dashboard", "stop"]);
            dashboard = undefined;
          }
        } finally {
          if ((await run(owner, ["session", "info"])).active) await run(owner, ["close"]);
        }
        rmSync(owner.directory, { recursive: true, force: true });
        handle = undefined;
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
}
