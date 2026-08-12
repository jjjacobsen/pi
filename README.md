# pi

All of my custom pi stuff: extensions, skills, and config. The goal is
zero dependence on third-party pi extensions; everything here is built in
house, piece by piece

## Layout

- `extensions/` - TypeScript extension entry points (pi requires TS modules)
- `src/` - Zig backends. One binary per extension, built by `build.zig`
- `docs/` - design notes
- `package.json` - pi package manifest; load this repo into pi with `pi install /path/to/this/repo`

## Extensions

### browser - headless browser via Lightpanda

`extensions/browser.ts` + `src/browser.zig`. Gives the model 26 `browser_*`
tools (navigate, read, click, fill, evaluate, waits, extract, search, ...)
backed by a real headless browser (Lightpanda) with a persistent session.
See [docs/architecture.md](docs/architecture.md).

```sh
mise check        # build + self-check (needs `lightpanda` on PATH)
```

## Adding a new extension

1. Write the backend in `src/foo.zig`, add it to the `bins` list in `build.zig`
2. Write `extensions/foo.ts` glue that spawns the binary and registers tools
3. Document it in `docs/architecture.md` and this README
