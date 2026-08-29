// Shared process handoff for full-screen terminal extensions

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";

export function capture(command, args, options = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function runOnTerminal(command, cwd, signal) {
  return new Promise<string>((resolve, reject) => {
    let tty;
    try {
      tty = openSync("/dev/tty", "r+");
    } catch {
      reject(new Error("cannot open controlling terminal /dev/tty"));
      return;
    }

    let child;
    try {
      child = spawn(command, [], { cwd, stdio: [tty, tty, tty] });
    } finally {
      closeSync(tty);
    }

    const abort = () => child.kill("SIGTERM");
    const cleanup = () => signal?.removeEventListener("abort", abort);

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, childSignal) => {
      cleanup();
      if (code !== null) resolve(`exited ${code}`);
      else resolve(`signal ${constants.signals[childSignal]}`);
    });

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
