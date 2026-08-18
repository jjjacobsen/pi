// pi-one-shot: shared helper for the one-shot Zig extension backends.
//
// One request per process: the glue spawns the binary with the request as a
// single JSON argv element, the binary prints one JSON envelope to stdout
// and exits. No persistent process, no stdio bridge, no lifecycle to manage.
// Fault tolerance is unchanged: a crash in the binary cannot take down pi.
//
// Request:  pi.exec(bin, [JSON.stringify(params)], { signal, timeout })
// Response: {"ok":true,"result":"...","usage":{...}} | {"ok":false,"error":"..."}
// Exit:     0 on ok, 1 on protocol error, non-zero on crash (stderr has it)

import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../.."); // extensions/lib/zig.ts -> repo root

function binaryPath(name) {
  return path.join(ROOT, "zig-out", "bin", name);
}

// Run one backend op and return the parsed envelope. Throws on a missing
// binary (with a rebuild hint), a killed process (abort or timeout), a crash
// (non-zero exit without an envelope), or a protocol-level error (ok:false).
export function callZig(
  pi,
  binaryName,
  params,
  options: { signal?: AbortSignal; timeout?: number } = {},
) {
  const bin = binaryPath(binaryName);
  if (!existsSync(bin)) {
    throw new Error(`${binaryName}: binary not found at ${bin}; run \`mise run build\` after editing src/`);
  }
  return pi.exec(bin, [JSON.stringify(params)], options).then((res) => {
    if (res.killed) {
      throw new Error(`${binaryName}: killed (aborted or timed out)`);
    }
    let msg = null;
    try {
      msg = JSON.parse(res.stdout);
    } catch {}
    if (res.code !== 0) {
      const detail = (msg?.error ?? res.stderr.trim()) || `exit code ${res.code}`;
      throw new Error(`${binaryName}: ${detail}`);
    }
    if (!msg || typeof msg !== "object") {
      const stderr = res.stderr ? `\n${res.stderr.slice(0, 500)}` : "";
      throw new Error(`${binaryName}: non-JSON response: ${res.stdout.slice(0, 200)}${stderr}`);
    }
    if (!msg.ok) {
      throw new Error(`${binaryName}: ${msg.error ?? "unknown error"}`);
    }
    return msg;
  });
}
