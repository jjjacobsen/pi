Custom pi extensions repo with small TypeScript modules that run directly in pi. The repo includes in-house extensions and selected work from people or organizations I trust

- Keep extensions in `extensions/` and shared helpers in `extensions/lib/`
- Use pi's extension SDK directly and keep each extension minimal
- `mise x -- hk check --all` must pass after every turn
- Update `docs/architecture.md` when architecture or protocols change, and keep the matching extension section in `README.md` in sync
- When adapting an existing package, extension, or idea, add a small credit note pointing to the original work
