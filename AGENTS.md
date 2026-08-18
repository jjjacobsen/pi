Custom pi extensions repo, built mostly in house. Most extensions are my own Zig, to learn the language and stay minimal, a few come from people or orgs I know and trust when a rewrite adds no value

- Extensions: thin TS glue in `extensions/`, all logic in Zig backends in `src/` (add to the `bins` list in `build.zig`)
- Extension glue that spawns a backend child must unref the child and its stdin/stdout pipes (`child.unref(); child.stdin.unref(); child.stdout.unref();`) so pi can exit in print mode and on shutdown; the backend self-terminates when its stdin closes
- New extensions must register `pi.on("session_shutdown", (event) => handleSessionShutdown(backend, event))` (the `createBackend` return value): backends are killed on host teardown (quit, reload) and reset on session replacement (new, resume, fork), where pi rebinds the loaded extension instances without re-importing them and a fresh child is respawned so no in-memory state bleeds across sessions
- `mise check` must pass after every turn
- Update `docs/architecture.md` when architecture or protocols change, and keep the matching extension section in `README.md` in sync
- Zig 0.16 quirks and lightpanda specifics are documented in `docs/architecture.md`, read it before touching `src/`
- When adapting an existing package, extension, or idea, add a small credit note pointing to the original work
