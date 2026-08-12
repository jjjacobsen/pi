# AGENTS

Custom pi extensions repo, built in house (no third-party pi packages).

- Extensions: thin TS glue in `extensions/`, all logic in Zig backends in `src/` (add to the `bins` list in `build.zig`)
- `mise check` must pass after every turn
- Update `docs/design.md` when architecture or protocols change
- Zig 0.16 quirks and lightpanda specifics are documented in `docs/design.md`, read it before touching `src/`
