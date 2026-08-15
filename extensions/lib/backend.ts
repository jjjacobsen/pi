// pi-backends: shared stdio bridge for the Zig extension backends.
//
// Every backend binary follows the same protocol: one JSON request line on
// stdin ({"id":1,"op":"...",...}), one JSON response line on stdout
// ({"id":1,"ok":true,...}). This helper owns spawning the binary, the
// pending-call map, line dispatch, and the unref dance that lets pi exit in
// print mode while the backend self-terminates on stdin EOF.
//
// hooks.onOk(msg) picks the resolved value (browser resolves the raw result
// string); hooks.onError(msg) returns the error message (goal adds a
// fallback when the backend omits "error").

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";

export function createBackend(binaryName, hooks = {}) {
  const root = path.resolve(import.meta.dirname, "../.."); // extensions/lib/backend.ts -> repo root
  const bin = path.join(root, "zig-out", "bin", binaryName);

  if (!existsSync(bin)) {
    const r = spawnSync("zig", ["build"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0 || !existsSync(bin)) {
      throw new Error(`${binaryName} binary missing; run \`zig build\` in ${root}`);
    }
  }

  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
  // Unref so pi can exit in print mode (and on shutdown) without waiting on
  // the backend's pipes; the backend self-terminates when stdin closes.
  child.unref();
  child.stdin.unref();
  child.stdout.unref();
  let nextId = 1;
  const pending = new Map();
  const settle = (id, fn) => {
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      fn(p);
    }
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.ok) settle(msg.id, (p) => p.resolve(hooks.onOk ? hooks.onOk(msg) : msg));
      else settle(msg.id, (p) => p.reject(new Error(hooks.onError ? hooks.onError(msg) : msg.error)));
    } catch {}
  });
  child.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error(`${binaryName} backend exited (code ${code})`));
    pending.clear();
  });
  child.on("error", (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  return {
    call(op, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
      });
    },
  };
}
