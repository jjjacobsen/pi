Custom pi extensions repo, built mostly in house. Most extensions are my own Zig, to learn the language and stay minimal, a few come from people or orgs I know and trust when a rewrite adds no value

- Extensions: thin TS glue in `extensions/`, all logic in Zig backends in `src/` (add to the `bins` list in `build.zig`)
- Extensions are one-shot: the glue runs the Zig binary per call through the shared `callZig` helper in `extensions/lib/zig.ts` (backed by `pi.exec`), with the request as one JSON argv element and one JSON envelope on stdout. The process exits after each call. No persistent process, no lifecycle management, no unref dance
- Only the persistent backends (browser, until it converts) use `createBackend` and must register `pi.on("session_shutdown", (event) => handleSessionShutdown(backend, event))`: backends are killed on host teardown (quit, reload) and reset on session replacement (new, resume, fork), where pi rebinds the loaded extension instances without re-importing them and a fresh child is respawned so no in-memory state bleeds across sessions
- `mise x -- hk check --all` must pass after every turn
- Update `docs/architecture.md` when architecture or protocols change, and keep the matching extension section in `README.md` in sync
- Zig 0.16 quirks and lightpanda specifics are documented in `docs/architecture.md`, read it before touching `src/`
- When adapting an existing package, extension, or idea, add a small credit note pointing to the original work
