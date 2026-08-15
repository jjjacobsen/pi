// pi-backends: shared stdio bridge for the Zig extension backends.
//
// Every backend binary follows the same protocol: one JSON request line on
// stdin ({"id":1,"op":"...",...}), one JSON response line on stdout
// ({"id":1,"ok":true,...}). This helper owns spawning the binary, the
// pending-call map, line dispatch, and the unref dance that lets pi exit in
// print mode while the backend self-terminates on stdin EOF.
//
// /reload safety (two guarantees):
// - Stale binaries are rebuilt: before spawning, if any source
//   (build.zig, build.zig.zon, anything under src/) is newer than the last
//   successful build (recorded in zig-out/.pi-build-stamp.json), run
//   `zig build`. A failed build throws instead of silently running the old
//   binary, so a reload after a Zig edit either runs the new code or tells
//   you why not. The stamp is project-wide and written once per successful
//   build, so the rebuild runs at most once per source change and a launch
//   with no source edits never invokes zig at all.
// - Old processes are killed on host teardown: use the exported
//   killOnHostTeardown(backend, event) from a pi.on("session_shutdown")
//   handler, which kills only when the host actually goes away (reason
//   "quit" or "reload"). kill() closes stdin (EOF is the backend's
//   self-terminate signal) and SIGTERMs as insurance, rejects pending
//   calls, and makes later calls fail fast. The kill closure holds only its
//   own child, so a reloaded extension instance can never kill the new
//   instance's backend. Session replacement ("new", "resume", "fork", /wt
//   switches) must NOT kill: pi rebinds the same loaded extension instances
//   without re-importing them, so the backend keeps serving the new session.
//
// hooks.onOk(msg) picks the resolved value (browser resolves the raw result
// string); hooks.onError(msg) returns the error message (goal adds a
// fallback when the backend omits "error").

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const STAMP_FILE = ".pi-build-stamp.json"; // in zig-out/, next to the binaries

// Newest mtime across everything a backend build depends on: build.zig,
// build.zig.zon, and every file under src/ (Zig files plus @embedFile
// assets like the peon sounds, and directories, whose mtime bumps when
// files are added or removed).
function newestSourceMtime(root) {
  let newest = 0;
  for (const rel of ["build.zig", "build.zig.zon"]) {
    const p = path.join(root, rel);
    if (existsSync(p)) {
      const m = statSync(p).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  const srcRoot = path.join(root, "src");
  for (const name of readdirSync(srcRoot, { recursive: true })) {
    const m = statSync(path.join(srcRoot, name)).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

// Newest source mtime at the last successful build, or 0 when the stamp is
// missing or unreadable (then the next load rebuilds once and rewrites it).
function readStamp(stampPath) {
  try {
    return JSON.parse(readFileSync(stampPath, "utf8")).newest;
  } catch {
    return 0;
  }
}

// Rebuild only when the source tree is newer than the last successful
// build, or the binary is missing. `zig build` compiles every binary in one
// step, so the project-wide stamp makes the rebuild run at most once per
// source change: other backends, later launches, and /reload all skip it
// until the next edit. A failed build throws: silently running a stale
// binary after /reload is worse than refusing to start.
function ensureBuilt(root, bin) {
  const stampPath = path.join(root, "zig-out", STAMP_FILE);
  const stale = !existsSync(bin) || newestSourceMtime(root) > readStamp(stampPath);
  if (!stale) return;
  const r = spawnSync("zig", ["build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0 || !existsSync(bin)) {
    throw new Error(`zig build failed (status ${r.status}) in ${root}; fix the build and /reload again`);
  }
  writeFileSync(stampPath, JSON.stringify({ newest: newestSourceMtime(root) }));
}

export function killOnHostTeardown(backend, event) {
  if (event.reason === "quit" || event.reason === "reload") backend.kill();
}

export function createBackend(binaryName, hooks = {}) {
  const root = path.resolve(import.meta.dirname, "../.."); // extensions/lib/backend.ts -> repo root
  const bin = path.join(root, "zig-out", "bin", binaryName);

  ensureBuilt(root, bin);

  let child;
  let rl;
  let nextId = 1;
  const pending = new Map();
  let killed = false;

  const spawnBackend = () => {
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    // Unref so pi can exit in print mode (and on shutdown) without waiting on
    // the backend's pipes; the backend self-terminates when stdin closes.
    child.unref();
    child.stdin.unref();
    child.stdout.unref();
    rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`${binaryName}: non-JSON line from backend: ${line.slice(0, 200)}`);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) {
        // A response for an unknown id can never settle a caller; surface it
        // instead of dropping it silently (that turned protocol bugs into
        // infinite tool-call hangs).
        console.error(`${binaryName}: response for unknown id ${msg.id}: ${line.slice(0, 200)}`);
        return;
      }
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(hooks.onOk ? hooks.onOk(msg) : msg);
      else entry.reject(new Error(hooks.onError ? hooks.onError(msg) : msg.error));
    });
    child.on("exit", (code) => {
      for (const p of pending.values()) p.reject(new Error(`${binaryName} backend exited (code ${code})`));
      pending.clear();
    });
    child.on("error", (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
  };
  spawnBackend();

  return {
    call(op, params) {
      return new Promise((resolve, reject) => {
        if (killed) return reject(new Error(`${binaryName} backend killed`));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
      });
    },
    kill() {
      if (killed) return;
      killed = true;
      for (const p of pending.values()) p.reject(new Error(`${binaryName} backend killed (session shutdown)`));
      pending.clear();
      // EOF on stdin is the backend's self-terminate signal; SIGTERM covers
      // a backend stuck mid-op. Pipes stay unref'd: pi must not wait on them.
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    },
    // Kill the backend (used when an in-flight call is aborted, e.g. Esc on a
    // slow vision request) and spawn a fresh one. Pending calls reject.
    restart() {
      child.kill();
      for (const p of pending.values()) p.reject(new Error(`${binaryName} backend restarted`));
      pending.clear();
      rl.close();
      spawnBackend();
    },
  };
}
