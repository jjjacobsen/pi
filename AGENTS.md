# AGENTS

Custom pi extensions repo, built in house (no third-party pi packages).

- Extensions: thin TS glue in `extensions/`, all logic in Zig backends in `src/` (add to the `bins` list in `build.zig`)
- Extension glue that spawns a backend child must unref the child and its stdin/stdout pipes (`child.unref(); child.stdin.unref(); child.stdout.unref();`) so pi can exit in print mode and on shutdown; the backend self-terminates when its stdin closes
- New extensions must also register `pi.on("session_shutdown", () => backend.kill())` (the `createBackend` return value) so /reload and session switches tear the old backend down instead of orphaning it
- `mise check` must pass after every turn
- Update `docs/architecture.md` when architecture or protocols change, and keep the matching extension section in `README.md` in sync
- Zig 0.16 quirks and lightpanda specifics are documented in `docs/architecture.md`, read it before touching `src/`
- When adapting an existing package, extension, or idea, add a small credit note pointing to the original work
