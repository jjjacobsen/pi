// pi-backends: shared stdio bridge for the Zig extension backends.
//
// Every backend binary follows the same protocol: one JSON request line on
// stdin ({"id":1,"op":"...",...}), one JSON response line on stdout
// ({"id":1,"ok":true,...}). This helper owns spawning the binary, the
// pending-call map, line dispatch, and the unref dance that lets pi exit in
// print mode while the backend self-terminates on stdin EOF.
//
// Lazy start: importing an extension must be cheap — pi imports every
// extension at startup, so createBackend spawns nothing until the first
// call (or restart). Ten backends plus Lightpanda only start when actually
// used.
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
// - Backends are torn down at session boundaries: use the exported
//   handleSessionShutdown(backend, event) from a pi.on("session_shutdown")
//   handler. Host teardown (reason "quit" or "reload") calls kill(): closes
//   stdin (EOF is the backend's self-terminate signal) and SIGTERMs as
//   insurance, rejects pending calls, and makes later calls fail fast. The
//   kill closure holds only its own child, so a reloaded extension instance
//   can never kill the new instance's backend. Session replacement ("new",
//   "resume", "fork") calls reset(): pi rebinds the same loaded extension
//   instances without re-importing them, and a terminal kill there would
//   leave the new session with a permanently dead backend, so reset kills
//   the child and respawns a fresh one instead, wiping in-memory state
//   (browser page, peon counters) so it never bleeds across sessions.
//   /clone goes through the same fork path, so every session replacement
//   starts with a clean backend.
//
// Child lifecycle:
// - Pending calls are scoped to their child generation, so a stale child's
//   late exit or late stdout line can never settle (or reject) a request
//   sent to the replacement child.
// - restart() (used when an in-flight call is aborted, e.g. Esc on a slow
//   vision/search request) kills the child and respawns only after it
//   exits, so old exit handlers never run against a new generation. Calls
//   made while the respawn is pending wait for the new child.
// - reset() (used at session replacement) is restart() without the eager
//   spawn: a backend that was never started stays unused, and a backend
//   that was started comes back to serve the new session with a fresh
//   process and clean state.
// - An unexpected child exit (crash) marks the backend dead; the next call
//   spawns a fresh child instead of writing into a dead pipe and hanging.
//
// hooks.onOk(msg) picks the resolved value (browser resolves the raw result
// string); hooks.onError(msg) picks the error message.

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
  for (const name of readdirSync(srcRoot, { recursive: true }) as string[]) {
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

// Session lifecycle wiring for every extension's pi.on("session_shutdown")
// handler. kill() is terminal and belongs to host teardown (quit, reload):
// nothing uses the backend after that. reset() is non-terminal and belongs
// to session replacement (new, resume, fork): pi rebinds the same loaded
// extension instances, so the backend must keep serving the next session,
// but its in-memory state must not survive the boundary.
export function handleSessionShutdown(backend, event) {
  if (event.reason === "quit" || event.reason === "reload") backend.kill();
  else backend.reset();
}

export function createBackend(
  binaryName,
  hooks: { onOk?: (msg: any) => any; onError?: (msg: any) => any } = {},
) {
  const root = path.resolve(import.meta.dirname, "../.."); // extensions/lib/backend.ts -> repo root
  const bin = path.join(root, "zig-out", "bin", binaryName);

  let child = null; // current backend child; null until first use or after exit
  let pending = new Map(); // current child generation's pending calls
  let nextId = 1;
  let killed = false; // kill() ran: terminal, nothing respawns
  let restarting = false; // restart() ran: respawn when the old child exits
  let crashed = false; // child exited unexpectedly; the next call respawns
  let built = false; // ensureBuilt ran for this module instance
  let waiters = []; // call() promises parked while a restart respawn is pending

  const rejectPending = (map, message) => {
    for (const p of map.values()) p.reject(new Error(message));
    map.clear();
  };

  const spawnBackend = () => {
    if (!built) {
      ensureBuilt(root, bin);
      built = true;
    }
    crashed = false;
    const genPending = new Map();
    pending = genPending;
    const c = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    // Unref so pi can exit in print mode (and on shutdown) without waiting on
    // the backend's pipes; the backend self-terminates when stdin closes.
    c.unref();
    (c.stdin as any).unref();
    (c.stdout as any).unref();
    // A write to a just-dead child's stdin surfaces as an async EPIPE here;
    // the pending call rejects via the exit handler, so nothing to do.
    c.stdin.on("error", () => {});
    child = c;
    const genRl = createInterface({ input: c.stdout });
    genRl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`${binaryName}: non-JSON line from backend: ${line.slice(0, 200)}`);
        return;
      }
      const entry = genPending.get(msg.id);
      if (!entry) {
        // A response for an unknown id can never settle a caller; surface it
        // instead of dropping it silently (that turned protocol bugs into
        // infinite tool-call hangs).
        console.error(`${binaryName}: response for unknown id ${msg.id}: ${line.slice(0, 200)}`);
        return;
      }
      genPending.delete(msg.id);
      if (msg.ok) entry.resolve(hooks.onOk ? hooks.onOk(msg) : msg);
      else entry.reject(new Error(hooks.onError ? hooks.onError(msg) : msg.error));
    });
    c.on("exit", (code) => {
      genRl.close();
      rejectPending(genPending, `${binaryName} backend exited (code ${code})`);
      if (child !== c) return; // a stale generation can never touch the new one
      child = null;
      if (restarting && !killed) {
        // Respawn only now: the old child is gone, so this exit handler (and
        // any late stdout lines) cannot interfere with the new generation.
        restarting = false;
        spawnBackend();
        const parked = waiters;
        waiters = [];
        for (const w of parked) w(null);
      } else if (!killed) {
        crashed = true; // unexpected exit; the next call spawns a fresh child
      }
    });
    c.on("error", (err) => {
      rejectPending(genPending, `${binaryName} backend error: ${err.message}`);
    });
  };

  return {
    call(op, params = {}) {
      return new Promise<any>((resolve, reject) => {
        if (killed) return reject(new Error(`${binaryName} backend killed`));
        const send = () => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          child.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
        };
        if (restarting) {
          // Parked until the respawned child is up (restart() resolved).
          waiters.push((err) => (err ? reject(err) : send()));
        } else if (!child) {
          // First use (lazy start) or after a crash: spawn, then send.
          spawnBackend();
          send();
        } else {
          send();
        }
      });
    },
    kill() {
      if (killed) return;
      killed = true;
      rejectPending(pending, `${binaryName} backend killed (session shutdown)`);
      const parked = waiters;
      waiters = [];
      for (const w of parked) w(new Error(`${binaryName} backend killed (session shutdown)`));
      if (!child) return;
      // EOF on stdin is the backend's self-terminate signal; SIGTERM covers
      // a backend stuck mid-op. Pipes stay unref'd: pi must not wait on them.
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    },
    // Reset the backend at a session boundary without making it terminal:
    // kills the child (fresh process, wiped in-memory state) and respawns
    // once it exits, with calls made meanwhile queued for the new child.
    // Unlike restart(), reset() does not spawn an unused backend: a backend
    // that was never started stays lazy, and one that was started comes back
    // to serve the new session.
    reset() {
      if (killed || restarting) return;
      if (!child) return;
      restarting = true;
      rejectPending(pending, `${binaryName} backend reset (session boundary)`);
      try {
        child.kill("SIGTERM");
      } catch {}
    },
    // Kill the backend (used when an in-flight call is aborted, e.g. Esc on a
    // slow vision request) and spawn a fresh one once the old child has
    // exited. Pending calls reject; calls made while the respawn is pending
    // wait for the new child.
    restart() {
      if (killed || restarting) return;
      if (!child) {
        spawnBackend();
        return;
      }
      restarting = true;
      rejectPending(pending, `${binaryName} backend restarted`);
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}
