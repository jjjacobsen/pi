import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Native CLI and dashboard: https://github.com/vercel-labs/agent-browser
export function createBrowserRuntime(pi: ExtensionAPI) {
  async function run(args: string[], cwd: string) {
    const result = await pi.exec("agent-browser", args, { cwd, timeout: 45000 });
    if (result.killed || result.code !== 0) throw new Error(result.stderr || result.stdout || "Browser command interrupted");
    return result.stdout;
  }

  return {
    async dashboard(cwd: string) {
      const { data: info } = JSON.parse(await run(["session", "info", "--json"], cwd));
      if (!info.active) return;
      if (info.runtimeError) throw new Error(info.runtimeError);
      if (!info.runtime.browserLaunched) return;
      const { data: started } = JSON.parse(await run(["dashboard", "start", "--json"], cwd));
      const url = `http://localhost:${started.port}/`;
      const [command, args] = process.platform === "darwin" ? ["open", [url]]
        : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
      const opened = await pi.exec(command, args, { cwd, timeout: 10000 });
      if (opened.killed || opened.code !== 0) throw new Error("Could not open the browser dashboard");
      return url;
    },
    close(cwd: string) {
      return run(["close", "--all"], cwd);
    },
  };
}
