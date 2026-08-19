Custom pi extensions repo, built mostly in house. Most extensions are my own Zig, to learn the language and stay minimal, a few come from people or orgs I know and trust when a rewrite adds no value

- Extensions: thin TS glue in `extensions/`, all logic in Zig backends in `src/` (add to the `bins` list in `build.zig`)
- Extensions are one-shot: the glue runs the Zig binary per call through the shared `callZig` helper in `extensions/lib/zig.ts` (backed by `pi.exec`), with the request as one JSON argv element and one JSON envelope on stdout. The process exits after each call. No persistent process, no lifecycle management, no unref dance
- The one exception is the browser: lightpanda cannot be one-shot (page and DOM state), so it runs as a long-lived daemon outside pi, started by `mise run daemon-start` as a launchd LaunchAgent (see `docs/daemons.md`). The browser glue and Zig backend stay one-shot and POST one MCP tools/call to `http://127.0.0.1:8931/mcp` with session `pi-main`. No session_shutdown wiring exists anywhere anymore
- `mise x -- hk check --all` must pass after every turn
- Update `docs/architecture.md` when architecture or protocols change, and keep the matching extension section in `README.md` in sync
- Zig 0.16 quirks and lightpanda specifics are documented in `docs/architecture.md`, read it before touching `src/`
- When adapting an existing package, extension, or idea, add a small credit note pointing to the original work
