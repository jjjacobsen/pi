# pi

All of my custom pi stuff: extensions, skills, and config. The goal is
zero dependence on third-party pi extensions; everything here is built in
house, piece by piece

## Layout

- `extensions/` - TypeScript extension entry points (pi requires TS modules);
  `extensions/backend.ts` is the shared stdio bridge all of them use
- `prompts/` - prompt templates (slash commands); served to pi via the package manifest
- `src/` - Zig backends. One binary per extension, built by `build.zig`;
  `src/common.zig` holds the IO/JSON/process helpers they all share
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

### goal - autonomous goal loop via /goal

`extensions/goal.ts` + `src/goal.zig`. The `/goal` command runs the agent
autonomously: `/goal <objective> [--min-time 1h] [--max-time 1h] [--min-tokens 100k] [--max-tokens 100k] [--no-ask]`, plus `/goal status | pause | resume | clear`. The Zig backend owns the whole state machine: min/max time and token boundaries, automatic continuation turns, a no-progress guard, stale-turn-safe goal_complete / goal_blocked / goal_wait tools, and it never asks questions mid-run. `--no-ask` removes even start-time questions for full automation. See [docs/architecture.md](docs/architecture.md).

## Prompts

### q - question only

`prompts/q.md` defines the `/q` slash command. It expands into an instruction
that tells the model not to make any changes, then passes through whatever you
type after it. Because this repo is loaded into pi as a package, the template
is available in every project, no per-machine copy needed. See
[pi prompt template docs](https://pi.dev) for the format.

## Skills

### repo-audit - whole-repo improvement audit

`skills/repo-audit/SKILL.md`, served to pi as a package skill. A repo-wide
scan for areas to improve: over-engineering, dead code, duplication,
dependency bloat, error handling gaps, performance and security red flags,
untested critical paths, and structural issues. Outputs one line per
finding, ranked biggest impact first, with the replacement named, and ends
with the net lines and deps removable. One-shot report, applies nothing.
Adapted from the ponytail-audit skill of
[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail): same
format and the cut/stdlib/native/yagni/shrink tags, extended with general
code audit categories.

## Adding a new extension

1. Write the backend in `src/foo.zig`, add it to the `bins` list in `build.zig`;
   reuse the helpers in `src/common.zig` (line reader, responder, `runCmd`)
2. Write `extensions/foo.ts` glue that registers tools and bridges via
   `createBackend("pi-foo")` from `extensions/backend.ts`
3. Document it in `docs/architecture.md` and this README
