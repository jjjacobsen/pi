---
name: convert-extension
description: >
  Convert a custom pi extension from the old persistent Zig backend model to
  the one-shot model: one JSON request as a single argv element via pi.exec,
  one JSON envelope on stdout, process exits. Covers the Zig main rewrite,
  the glue rewrite, state file conventions under the agent dir, doc updates,
  and verification. Use when adding a new extension in the one-shot style or
  when touching a legacy backend. All extensions are converted (browser last,
  as a client to the lightpanda daemon); this skill documents the target
  shape.
metadata:
  author: jonah
  version: "1.0.0"
---

# Convert extension to one-shot

## Target architecture

```
pi (coding agent)
  └─ extensions/foo.ts    TS glue: tool schema + callZig
       └─ src/foo.zig     one-shot binary: argv in, stdout envelope out, exit
```

Every extension is a one-shot child process. The glue spawns the binary per
call with `pi.exec`, the binary does its work, prints one JSON envelope to
stdout, and exits. No persistent processes, no stdio bridge, no lifecycle
management, no session_shutdown wiring. Fault tolerance is unchanged: a
crash in the binary cannot take down pi.

Protocol:

```
pi.exec(bin, [JSON.stringify(req)], { signal, timeout })
req is one JSON object, no id: {"op":"foo","...params"}
stdout: {"ok":true,"result":"...","usage":{...}} | {"ok":false,"error":"..."}
exit:   0 on ok, 1 on protocol error, other on crash (trace on stderr)
```

## Reference implementation

`extensions/search.ts`, `extensions/lib/zig.ts`, and the `src/search.zig`
main are the template. Search was the first conversion. Read all three
before converting anything else.

## State rules

- Config and state live under the agent dir, one file per extension
- The glue is the single source of truth for the path: it resolves
  `getAgentDir()` from `@earendil-works/pi-coding-agent` (pi's own
  resolution, which handles `PI_CODING_AGENT_DIR` and rebranded builds)
  and passes it as an `agent_dir` field in the request JSON
- The zig backend requires `agent_dir` and fails loudly when it is
  missing. No `~/.pi/agent` fallback, no hardcoded path, no env reading.
  Pi does not export `PI_CODING_AGENT_DIR` to children by default, so a
  fallback would either break on the default install or silently guess
- Only send `agent_dir` when the backend needs state. Stateless backends
  (search) never require it
- Naming: `<name>.json` for config, `<name>-state.json` or `-cache.bin`
  for state. Existing examples: `vision.json`, `peon.json`,
  `pi-usage-cache.bin`, `cua-screenshots/`
- Write state atomically: temp file + rename (the usage cache pattern)
- State that pi itself needs stays in pi: `pi.appendEntry()` session
  entries (the glue round-trips them back in per request)
- The old env-with-fallback resolution (`agentDir` in `src/usage.zig`,
  the hardcoded `~/.pi/agent` in `peon.zig` and `cua.zig`) dies with
  each conversion. The `agent_dir` request field is the replacement shape

## Conversion checklist

### 1. Read the extension's current shape

Read `extensions/foo.ts`, the `main` in `src/foo.zig`, and the extension's
section in `docs/architecture.md`. Note every op, every param, and every
piece of state.

### 2. Classify and relocate state

In-memory backend state cannot survive a one-shot process. For each piece:
- stateless: nothing to do
- config: already on disk in the agent dir, keep
- counters/timestamps/pids: move to a state file in the agent dir
  (peon's debounce/spam ring)
- session-scoped state pi needs: keep in the glue (session entries,
  round-tripped per request)

### 3. Convert the Zig main

- Drop `id` from the request struct and the response. One request per
  process, responses are self-addressing
- Parse the request from `argv[1]` instead of a stdin line
  (`std.mem.sliceTo(argv[1], 0)`), with `.ignore_unknown_fields = true`
- Add `agent_dir: ?[]const u8 = null` to the request struct when the
  backend needs state, and fail loudly when the op needs it but it is
  missing (no fallback, see state rules)
- Dispatch, then finish with `common.respondExit` (plain text) or
  `common.respondOutcomeExit` (Outcome, carries the optional usage JSON).
  Both are noreturn: they print the envelope and exit 0/1
- Remove the stdin loop, the `readLine` import, and the `MAX_LINE` const
- Template main:

```zig
pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-foo '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const outcome = if (mem.eql(u8, req.value.op, "foo"))
        opFoo(gpa, arena, io, req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else
        respondExit(arena, io, false, "unknown op");

    respondOutcomeExit(arena, io, outcome);
}
```

### 4. Convert the glue

- Import `callZig` from `./lib/zig`. Drop the `createBackend`,
  `handleSessionShutdown`, and `withAbort` imports
- Remove the module-level `const backend = createBackend(...)` line and
  the `pi.on("session_shutdown", ...)` line
- In `execute`, replace the `withAbort(backend, backend.call(...))` with:

```ts
const res = await callZig(pi, "pi-foo", { op: "foo", ...params }, { signal, timeout: TIMEOUT_MS });
return { content: [{ type: "text", text: res.result }], details: {}, ...(res.usage ? { usage: res.usage } : {}) };
```

- `callZig` throws on missing binary (with a rebuild hint), kill
  (abort/timeout), crash, or `ok:false`. Keep the existing try/catch and
  `toolError` so the model sees a failed tool call. Keep argument-level
  checks (like search's missing EXA_API_KEY) before the call
- Include `agent_dir: getAgentDir()` in the request params when the
  backend needs state (import `getAgentDir` from
  `@earendil-works/pi-coding-agent`, `extensions/vision.ts` already does)
- Keep forwarding `res.usage` (search, vision) and `toToolUsage` where the
  extension already uses it (vision)
- Commands (commit, lazygit, peon) call `callZig` the same way
  from their handlers, with `ctx.signal` when available

### 5. Verify

- `mise run build` compiles every backend (cua keeps the shared
  `readLine` for draining its child's stdout; the old id-based
  `respond`/`respondOutcome` are gone with the browser conversion)
- Smoke test the binary directly:
  - success path: `./zig-out/bin/pi-foo '{"op":"foo",...}'` prints the
    envelope, exits 0
  - protocol error: envelope with `"ok":false`, exits 1
  - garbage argv: error envelope, exits 1
  - no argv: usage line, exits 2
- `mise x -- hk check --all` (tsc) stays green

### 6. Update docs

- `docs/architecture.md`: rewrite the extension's section (protocol block,
  glue behavior, notes). The shared-code section at the top describes the
  one-shot model and the browser daemon exception, only touch it when a
  convention changes
- `README.md`: the extension blurb, only when behavior text changed
- `AGENTS.md`: only when a convention changes (the first conversion
  rewrote the backend bullets, done)
- `docs/papercuts.md`: append anything that cost time

## Per-extension notes

| Extension | State today | Conversion notes |
|---|---|---|
| search | none | DONE. Reference implementation |
| commit | none | trivial. analyze/validate/commit ops. keep the 24KB context caps |
| usage | cache already on disk | trivial. swap the env-with-fallback resolution for the `agent_dir` request field |
| vision | config in vision.json | trivial. api key travels in argv (same-user visibility, acceptable, see gotchas). keep usage accounting, sips, retry |
| cua | screenshots dir hardcoded | trivial. accept the `agent_dir` request field (it already takes a `shots_dir` override). in-band driver errors still pass through as results |
| lazygit | none | trivial. run op blocks until lazygit exits. TUI stop/start stays in the glue |
| peon | config in peon.json, counters in memory | counters to peon-state.json (debounce timestamps, spam ring, last played, afplay pid). one-sound-at-a-time = read pid, kill, spawn, write pid. accept the `agent_dir` request field. sound extraction runs per event, it is idempotent |
| browser | page lives in the lightpanda daemon | DONE (daemon model). page state is process state, so lightpanda runs as a launchd LaunchAgent started by `mise run daemon-start` (docs/daemons.md); the glue and zig stay one-shot and POST one MCP tools/call to `http://127.0.0.1:8931/mcp` with session `pi-main`. see the browser section below |

## Gotchas

- argv budget: macOS 1 MiB total for argv + env, no per-argument cap.
  Linux caps one argument at 128 KiB. Largest payloads today are ~24 KiB
  (commit digest). If a payload ever grows past ~100 KiB,
  write it to a temp file and pass the path
- Secrets in argv are visible to same-user processes via ps. No worse
  than auth.json on disk. Prefer env-derived keys (EXA_API_KEY) when
  possible
- `pi.exec` has no stdin and no env override. signal + timeout only. The
  timeout is in milliseconds. That is why paths like agent_dir ride the
  request JSON instead of the child environment
- `pi.exec` kills only the direct child on abort (SIGTERM, SIGKILL after
  5 s). Descendants die when their stdin pipes close (lightpanda, afplay)
  or finish on their own (cua-driver). A backend that spawns long-lived
  children should install a SIGTERM handler (cua.zig pattern)
- Custom tool results are not auto-truncated (the bash tool's 50 KiB cap
  is bash-only). Keep the Zig-side output caps
- The old id-based `respond`/`respondOutcome` were deleted from common.zig
  with the browser conversion (browser was their last user). `readLine`
  stays: cua uses it to drain the cua-driver child's stdout
- Exit code is a fallback channel, the envelope is authoritative. The
  glue parses stdout JSON first and reports a killed process (timeout or
  abort) before the exit code
- Do not add new stateful features to converted extensions without a
  state file. In-memory backend state is gone by design

## Browser (daemon model)

The browser cannot be one-shot: the page, DOM, and node ids are process
state in lightpanda, and `backendNodeId`s returned by one call must be
usable by the next. The shape it ended up with:

- lightpanda runs as a launchd LaunchAgent (`lightpanda mcp --port 8931`),
  the only persistent process in the setup, owned by the OS not by pi.
  `mise run daemon-start` installs the agent and starts it, `mise run
  daemon-status` checks it. On a different machine: install lightpanda,
  run daemon-start once (docs/daemons.md).
- The glue and the Zig binary are one-shot like everything else. The Zig
  client POSTs one MCP tools/call (JSON-RPC 2.0 over HTTP) to
  `http://127.0.0.1:8931/mcp` and exits.
- Session identity: every call sends the header `Mcp-Session-Id: pi-main`.
  The server routes by header, keeps the page alive after the client
  disconnects, serializes calls per session, and creates the session on
  first use without an initialize handshake. All verified in a spike
  against the 2026.08 nightly.
- Esc kills only the one-shot client; the in-flight call finishes
  server-side (~30s worst case) and the next call queues behind it. The
  page is never lost to an abort.
- Per-call deadline uses the shared `httpWithDeadline` worker from
  common.zig (worker thread, socket shutdown on expiry), and results are
  capped by the shared 64KiB WorkerSlot.

This replaced the old persistent stdio bridge (`extensions/lib/backend.ts`,
`createBackend`, `withAbort`, and the id-based `respond`/`respondOutcome`),
all of which are deleted.
