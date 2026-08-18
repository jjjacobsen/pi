// pi-wt: /wt command glue for the Zig worktree backend.
//
// Thin TS: registers the /wt command and owns the pi session replacement,
// which only code inside the pi process can do. All git logic lives in the
// Zig backend (src/wt.zig) over a newline-delimited JSON pipe.
//
// Commands:
//   /wt               create a worktree (auto name, e.g. wt/angry-aardvark)
//                     and switch this pi session into a fresh session there
//   /wt <topic>       create branch wt/<topic>, or switch back into the
//                     worktree if it already exists (resumes its most
//                     recent session when there is one)
//   /wt list          show all worktrees (branch, path, clean/dirty)
//   /wt merge <topic> [--keep]  merge wt/<topic> into the current branch,
//                     then prune the worktree unless --keep
//   /wt prune <topic> remove the worktree and delete the branch
//
// Protocol (one JSON object per line):
//   -> {"id":1,"op":"create","cwd":"/path","topic":"x"}
//   <- {"id":1,"ok":true,"result":"{\"path\":...,\"branch\":...,\"topic\":...,\"base\":...}"}
//   -> {"id":2,"op":"list","cwd":"/path"}            <- {"id":2,"ok":true,"result":"<text>"}
//   -> {"id":3,"op":"merge","cwd":"/path","topic":"x"}
//   <- {"id":3,"ok":true,"result":"{\"merged\":...,\"up_to_date\":...,\"branch\":...,\"text\":...}"}
//   -> {"id":4,"op":"prune","cwd":"/path","topic":"x"} <- {"id":4,"ok":true,"result":"<text>"}
//   -> {"id":5,"op":"find","cwd":"/path","topic":"x"}
//   <- {"id":5,"ok":true,"result":"{\"path\":...,\"branch\":...,\"topic\":...}"}   (or "no worktree for...")

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createBackend, handleSessionShutdown } from "./lib/backend";
import { prefixCompletions } from "./lib/toolkit";

const backend = createBackend("pi-wt");

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[wt] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

// Session file to switch to for a worktree: the most recent session whose
// header cwd is the worktree path (resumes its history), or a fresh session
// file rooted there. Then replace the current session with it.
//
// Fresh files must carry the worktree path in the header: interactive mode
// drops cwdOverride from ctx.switchSession (pi's handleResumeSession only
// forwards withSession), so without it the new session falls back to the
// process cwd and keeps operating on the main checkout.
async function sessionFileForWorktree(worktreePath) {
  try {
    const sessions = await SessionManager.list(worktreePath); // sorted newest first
    const recent = sessions.find((s) => s.cwd === worktreePath);
    if (recent) return { sessionFile: recent.path, resumed: true };
  } catch {
    // unreadable session dir: fall through to a fresh session
  }
  // Creates the worktree's session directory and returns the session file
  // path pi would use for that cwd (SessionManager.create mkdirs the dir and
  // generates the timestamped filename; the file itself is written lazily).
  const sessionFile = SessionManager.create(worktreePath).getSessionFile();
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: worktreePath,
    }) + "\n",
  );
  return { sessionFile, resumed: false };
}

async function switchToWorktree(ctx, worktreePath, branch, base) {
  const { sessionFile, resumed } = await sessionFileForWorktree(worktreePath);
  const result = await ctx.switchSession(sessionFile, {
    cwdOverride: worktreePath,
    withSession: async (nctx) => {
      const where = resumed ? "resumed session" : `fresh session${base ? ` (from ${base})` : ""}`;
      notify(nctx, `now in worktree ${branch}, ${where}`, "info");
    },
  });
  if (result.cancelled) {
    notify(ctx, `worktree ${branch} at ${worktreePath}: the session switch was cancelled`, "warning");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", (event) => handleSessionShutdown(backend, event));
  pi.registerCommand("wt", {
    description: "Create a git worktree and switch to a pi session in it (re-enters an existing worktree; /wt list, /wt merge <topic>, /wt prune <topic>)",
    getArgumentCompletions: (prefix) => prefixCompletions(["list", "merge", "prune"], prefix),
    handler: async (args, ctx) => {
      // Session replacement needs the pi TUI. RPC mode cannot service the
      // backend child-pipe I/O (upstream pi quirk: any await on a
      // createBackend call hangs there), and print/json modes are one-shot.
      if (ctx.mode !== "tui") return notify(ctx, "only available in the pi TUI", "warning");

      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = argv[0];
      const rest = argv.slice(1);

      if (cmd === "list") {
        try {
          const r = await backend.call("list", { cwd: ctx.cwd });
          notify(ctx, r.result, "info");
        } catch (err) {
          notify(ctx, err?.message ?? String(err), "error");
        }
        return;
      }

      if (cmd === "merge" || cmd === "prune") {
        const topic = rest.find((a) => a !== "--keep");
        if (!topic) return notify(ctx, `usage: /wt ${cmd} <topic>${cmd === "merge" ? " [--keep]" : ""}`, "warning");
        if (cmd === "merge") {
          const keep = rest.includes("--keep");
          try {
            const r = await backend.call("merge", { cwd: ctx.cwd, topic });
            const m = JSON.parse(r.result);
            if (!m.merged) {
              notify(ctx, m.text, "warning");
              return;
            }
            if (keep) {
              notify(ctx, `${m.text} (worktree kept)`, "info");
              return;
            }
            try {
              const p = await backend.call("prune", { cwd: ctx.cwd, topic });
              notify(ctx, `${m.text}; ${p.result}`, "info");
            } catch (err) {
              notify(ctx, `${m.text}; prune failed: ${err?.message ?? String(err)}`, "warning");
            }
          } catch (err) {
            notify(ctx, err?.message ?? String(err), "error");
          }
        } else {
          try {
            const r = await backend.call("prune", { cwd: ctx.cwd, topic });
            notify(ctx, r.result, "info");
          } catch (err) {
            notify(ctx, err?.message ?? String(err), "error");
          }
        }
        return;
      }

      // Bare /wt or /wt <topic>: switch into the worktree if it already
      // exists, otherwise create it, then switch sessions.
      const topic = cmd && !cmd.startsWith("-") ? cmd : undefined;
      if (topic) {
        try {
          const found = JSON.parse((await backend.call("find", { cwd: ctx.cwd, topic })).result);
          try {
            await switchToWorktree(ctx, found.path, found.branch);
          } catch (err) {
            notify(ctx, `session switch into worktree ${found.branch} at ${found.path} failed: ${err?.message ?? String(err)}`, "error");
          }
          return;
        } catch (err) {
          const msg = err?.message ?? String(err);
          if (!msg.startsWith("no worktree for")) {
            notify(ctx, msg, "error");
            return;
          }
          // no worktree yet: fall through and create one
        }
      }
      let created;
      try {
        created = JSON.parse((await backend.call("create", { cwd: ctx.cwd, topic })).result);
      } catch (err) {
        notify(ctx, err?.message ?? String(err), "error");
        return;
      }
      try {
        await switchToWorktree(ctx, created.path, created.branch, created.base);
      } catch (err) {
        // The worktree exists even if the session switch failed; tell the
        // user so they can cd there manually or prune it later.
        notify(ctx, `worktree ${created.branch} created at ${created.path} but the session switch failed: ${err?.message ?? String(err)}`, "error");
      }
    },
  });
}
