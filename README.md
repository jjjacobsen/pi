# pi

All of my custom pi stuff: extensions, skills, and config. The goal is
zero dependence on third-party pi extensions; everything here is built in
house, piece by piece

## Layout

- `extensions/` - TypeScript extension entry points (pi requires TS modules)
- `prompts/` - prompt templates (slash commands); served to pi via the package manifest
- `src/` - Zig backends. One binary per extension, built by `build.zig`
- `docs/` - design notes; [installed-packages.md](docs/installed-packages.md) lists all pi packages installed via `settings.json`
- `package.json` - pi package manifest; load this repo into pi with `pi install /path/to/this/repo`

## Extensions

### commit - AI commit messages

`extensions/commit.ts` + `src/commit.zig`. The `/commit` command stages all
changes and creates a conventional commit with a model-generated message:
repo style from `git log`, a diff digest, AGENTS.md commit guidance, session
context for the "why", strict validation with one retry, thinking level
`low` for speed. See [docs/architecture.md](docs/architecture.md).

### browser - headless browser via Lightpanda

`extensions/browser.ts` + `src/browser.zig`. Gives the model 26 `browser_*`
tools (navigate, read, click, fill, evaluate, waits, extract, search, ...)
backed by a real headless browser (Lightpanda) with a persistent session.
See [docs/architecture.md](docs/architecture.md).

```sh
mise check        # build + self-check (needs `lightpanda` on PATH)
```

### lazygit - full-screen git TUI via /lg

`extensions/lazygit.ts` + `src/lazygit.zig`. The `/lg` command pauses the pi
TUI and hands the whole terminal to lazygit, exactly like lazygit.nvim does
over nvim: it validates the target is a git repo and lazygit is on PATH, stops
pi's renderer, spawns lazygit on `/dev/tty`, then resumes and reports the exit
status. See [docs/architecture.md](docs/architecture.md).

## Prompts

### q - question only

`prompts/q.md` defines the `/q` slash command. It expands into an instruction
that tells the model not to make any changes, then passes through whatever you
type after it. Because this repo is loaded into pi as a package, the template
is available in every project, no per-machine copy needed. See
[pi prompt template docs](https://pi.dev) for the format.

## Adding a new extension

1. Write the backend in `src/foo.zig`, add it to the `bins` list in `build.zig`
2. Write `extensions/foo.ts` glue that spawns the binary and registers tools
3. Document it in `docs/architecture.md` and this README
