import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Native agent-browser 0.39.1: get_socket_dir, walk_daemons, is_pid_alive
// https://github.com/vercel-labs/agent-browser/blob/v0.39.1/cli/src/connection.rs
// Find live daemon PID records, not tabs or Chromium child processes. Unlike
// walk_daemons, this read-only scan never removes stale metadata or reads keys.
async function entries(directory: string) {
	try {
		return await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function directoryHasActiveBrowser(directory: string): Promise<boolean> {
	for (const entry of await entries(directory)) {
		if (!entry.name.endsWith(".pid") || entry.name === ".pid" || entry.name === "dashboard.pid") continue;
		let text: string;
		try {
			text = (await readFile(join(directory, entry.name), "utf8")).trim();
		} catch (error) {
			if (error.code === "ENOENT") continue; // A session closed during the scan.
			throw error;
		}
		// Match Rust's u32 parser, then its cast to i32 for kill(pid, 0).
		if (!/^\+?\d+$/.test(text)) continue;
		const pid = Number(text);
		if (pid > 0xffffffff) continue;
		try {
			process.kill(pid | 0, 0);
		} catch (error) {
			// Native treats EPERM and every error except ESRCH as alive.
			if (error.code === "ESRCH") continue;
		}
		return true;
	}
	return false;
}

export async function hasActiveBrowsers(): Promise<boolean> {
	const home = homedir();
	const defaultRoot = process.env.XDG_RUNTIME_DIR
		? join(process.env.XDG_RUNTIME_DIR, "agent-browser")
		: home ? join(home, ".agent-browser") : join(tmpdir(), "agent-browser");
	// browser.sh clears AGENT_BROWSER_SOCKET_DIR. Include its default root even
	// when the native CLI uses an explicit override. Ignore namespace selection:
	// scan default sessions and every namespace, including abandoned pi owners.
	const roots = new Set([defaultRoot, process.env.AGENT_BROWSER_SOCKET_DIR || defaultRoot]);
	const directories = new Set<string>();
	for (const candidate of roots) {
		let root: string;
		try {
			root = await realpath(candidate);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		directories.add(root);
		for (const entry of await entries(join(root, "namespaces"))) {
			if (entry.isDirectory()) directories.add(join(root, "namespaces", entry.name, "run"));
		}
	}
	for (const directory of directories) {
		if (await directoryHasActiveBrowser(directory)) return true;
	}
	return false;
}
