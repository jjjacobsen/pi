---
name: convert-extension
description: >
  Convert a custom pi extension in this repo from the persistent Zig backend
  model to the one-shot model: one JSON request as a single argv element via
  pi.exec, one JSON envelope on stdout, process exits. Covers the Zig main
  rewrite, the glue rewrite, state file conventions under the agent dir, doc
  updates, and verification. Use when converting an extension to one-shot,
  when adding a new extension in the one-shot style, or when a converted
  extension still uses the old createBackend bridge. Browser is the
  exception: it stays persistent by design and is excluded for now.
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
  entries (goal already round-trips its state this way)
- The old env-with-fallback resolution (`agentDir` in `src/usage.zig`,
  the hardcoded `~/.pi/agent` in `peon.zig` and `cua.zig`) dies with
  each conversion. cua's existing `shots_dir` request field shows the way

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
  (peon's debounce/spam ring, btw's thread)
- session-scoped state pi needs: keep in the glue (session entries,
  round-tripped per request like goal)

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
- Keep the `--self-check` branch untouched (self-checks leave the project
  later, not per-extension). Fix request literals in the self-check that
  set `.id`
- Template main:

```zig
pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len > 1 and mem.eql(u8, std.mem.sliceTo(argv[1], 0), "--self-check")) {
        try selfCheck(gpa, io);
        return;
    }
    if (argv.len < 2) {
        std.debug.print("usage: pi-foo '<request json>' | --self-check\n", .{});
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
- Commands (commit, goal, btw, lazygit, peon) call `callZig` the same way
  from their handlers, with `ctx.signal` when available

### 5. Verify

- `mise run build` compiles every backend (the unconverted ones must not
  break: the old `respond`/`respondOutcome`/`readLine` stay in common.zig)
- Smoke test the binary directly:
  - success path: `./zig-out/bin/pi-foo '{"op":"foo",...}'` prints the
    envelope, exits 0
  - protocol error: envelope with `"ok":false`, exits 1
  - garbage argv: error envelope, exits 1
  - no argv: usage line, exits 2
- `mise x -- hk check --all` (tsc) stays green
- While self-checks still exist: `zig build run -- --self-check`

### 6. Update docs

- `docs/architecture.md`: rewrite the extension's section (protocol block,
  glue behavior, notes). The shared-code section at the top describes the
  one-shot model and the persistent remnant, only touch it when a
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
| goal | glue round-trips state, session entries | glue-only. events fire one-shot spawns. restore on session_start unchanged |
| btw | thread in backend arena | move the turns array to the glue (it already sees every message) or to a state file, pass it per op. also fixes the old RPC-mode child-pipe hang |
| peon | config in peon.json, counters in memory | counters to peon-state.json (debounce timestamps, spam ring, last played, afplay pid). one-sound-at-a-time = read pid, kill, spawn, write pid. accept the `agent_dir` request field. sound extraction runs per event, it is idempotent |
| browser | page in lightpanda process | NOT converted. persistent by design (forms, dev server validation). last user of backend.ts. see the browser section below |

## Gotchas

- argv budget: macOS 1 MiB total for argv + env, no per-argument cap.
  Linux caps one argument at 128 KiB. Largest payloads today are ~24 KiB
  (btw context, commit digest). If a payload ever grows past ~100 KiB,
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
- The old id-based `respond`/`respondOutcome` and `readLine` stay in
  common.zig for the unconverted backends. Do not delete them
  mid-transition. They die with the last non-browser conversion
- Exit code is a fallback channel, the envelope is authoritative. The
  glue parses stdout JSON first and reports a killed process (timeout or
  abort) before the exit code
- Do not add new stateful features to converted extensions without a
  state file. In-memory backend state is gone by design

## Browser (excluded, for later)

Two paths when it eventually converts:
- keep the current persistent stdio bridge, trimmed to browser alone
- or: the glue owns one persistent `lightpanda mcp --port N` process (the
  only persistent process left in the setup), one-shot zig clients POST
  JSON-RPC to `/mcp` with the `Mcp-Session-Id` header, and cookies
  persist via `--cookie` / `--cookie-jar`. Page state, node ids, and
  form state live in lightpanda, and Esc kills only the client, not the
  page. Needs a spike to verify session survival across client
  disconnects before committing to it
