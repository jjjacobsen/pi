# pi

All of my custom pi stuff: extensions, skills, and config. The goal is
zero dependence on third-party pi extensions; everything here is built in
house, piece by piece

## Layout

- `extensions/` - TypeScript extension entry points (pi requires TS modules);
  `extensions/lib/backend.ts` is the shared stdio bridge all of them use.
  It rebuilds binaries when sources changed (stamped in
  `zig-out/.pi-build-stamp.json`, so at most once per edit) and kills old
  backends on host teardown (`session_shutdown` with reason quit/reload via
  `killOnHostTeardown`), so `/reload` picks up Zig and TS changes with no
  orphaned processes, while
  `/new` keeps the backends alive for the new session
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

### peon - Warcraft peon sounds via /peon

`extensions/peon.ts` + `src/peon.zig`. Plays random orc peon and human peasant voice lines on pi events: session start, task acknowledge, task complete, task error, and rapid prompt spam. `/peon` opens the settings panel (volume, silent window, per-category toggles). The 33 wavs are embedded in the binary, config lives in `~/.pi/agent/peon.json`, and all decisions live in Zig. Replaces the third-party pi-peon-ping extension (no pack picker, relay, desktop notifications, or preview sound). See [docs/architecture.md](docs/architecture.md).

### usage - usage dashboard via /usage

`extensions/usage.ts` + `src/usage.zig`. The `/usage` command shows usage stats for Today / This Week / Last Week / Last 30 Days / All Time across four views: Graphs (braille charts by provider/model/thinking, cumulative toggle), Table (providers to models, filter/hide/expand), Insights (cost advice), and Limits (provider quota: OpenAI Codex subscription and OpenCode Go 5h/weekly/monthly windows with usage bars, reset timers, plan/account info, Codex saved resets). All data collection runs in the Zig backend: session JSONL scanning with a binary cache, aggregation, insights, and the quota fetches. Replaces the third-party `@tmustier/pi-usage-extension`; the limits view is adapted from omp (can1357/oh-my-pi). See [docs/architecture.md](docs/architecture.md).

### footer - custom status footer via /footer

`extensions/footer.ts`. Pure TS, no Zig backend. Replaces pi's built-in footer with an opencode-style two-line footer: `π  ~/Projects/pi  main` workspace line on top (nerd font icons), token/cost/context stats on the bottom with the model and reasoning level right-aligned. Drops the built-in footer's R (cache read), W (cache write), CH (cache hit %) and (auto) compaction segments, and adds a tok/s readout (estimated from streamed characters; live while streaming, frozen at the last value when idle, placed last so the line never shifts). Enabled automatically at session start; `/footer` toggles back to the built-in footer. See [docs/architecture.md](docs/architecture.md).

### wt - parallel agents via git worktrees

`extensions/wt.ts` + `src/wt.zig`. The `/wt` command creates a git worktree
from the current branch head (never carrying uncommitted changes) and
switches the current pi session into a fresh session there, so you can run
parallel agents on one repo, each isolated. Bare `/wt` names the worktree
`wt/<adjective>-<noun>` (e.g. `wt/angry-aardvark`), `/wt <topic>` names it
`wt/<topic>` (and re-enters an existing worktree with that topic, resuming
its most recent session). All commands work from inside a worktree too:
`/wt list` shows every worktree relative to the repo root, and new
worktrees are always created under the main checkout. Worktrees live in
`<repo>/.wt/`, excluded from git status via `.git/info/exclude`.
`/wt list` shows all worktrees,
`/wt merge <topic>` brings the worktree branch into your current branch
(fast-forward when possible, conflicts left for normal resolution) and
auto-prunes unless `--keep`, `/wt prune <topic>` removes a worktree and its
branch. See [docs/architecture.md](docs/architecture.md).

### btw - quick side questions via /btw

`extensions/btw.ts` + `src/btw.zig`. The `/btw [question]` command opens a
side-chat window that stays inside the session TUI (the transcript remains
visible above it) and answers questions with the current model at `low`
thinking, ELI15-style, without touching the main conversation. Multiple
questions work: type one while an answer streams and it queues. In the
window: `enter` send, `c` copy the thread to the clipboard, `b` bring
the thread into the main chat, `esc` dismiss (main chat untouched). All
thread logic lives in the Zig backend: the ELI15 system prompt with the
main-chat excerpt embedded, history assembly, thread formatting, and
pbcopy. Replaces
the third-party `@narumitw/pi-btw` package (removed from settings). See
[docs/architecture.md](docs/architecture.md).

### vision - image analysis via a configured vision model

`extensions/vision.ts` + `src/vision.zig`. The `describe_image` tool lets a
text-only primary (like deepseek-v4-flash) analyze images by delegating to a
configured vision model: Zig detects the format and dimensions from header
bytes, compresses oversized images via `sips` (JPEG for opaque, PNG/GIF for
alpha so transparency survives), base64s, and POSTs to the model's
OpenAI-compatible
endpoint with one retry and a hard deadline. Multimodal models never see the
tool — pi passes images to them natively. `/vision show` and
`/vision model <provider/model>` configure the vision model. Replaces the
third-party @getpipher/vision package. See
[docs/architecture.md](docs/architecture.md).

### search - web search via the Codex subscription

`extensions/search.ts` + `src/search.zig`. The `web_search` tool runs the
same server-side OpenAI web search pipeline the Codex CLI uses, free with a
Codex subscription: the model plans queries, OpenAI's index searches, and
the answer comes back grounded with `[n]` citation markers into a numbered
source list. Mode `answer` (default) returns the cited answer plus sources;
mode `results` stops streaming once the searches complete and returns only
the sources, cutting most of the latency. One retry on transient failures,
a hard deadline, Esc aborts, and no config file: auth comes from pi's model
registry. Replaces the third-party pi-web-access package (uninstalled). See
[docs/architecture.md](docs/architecture.md).

## Adding a new extension

1. Write the backend in `src/foo.zig`, add it to the `bins` list in `build.zig`;
   reuse the helpers in `src/common.zig` (line reader, responder, `runCmd`)
2. Write `extensions/foo.ts` glue that registers tools and bridges via
   `createBackend("pi-foo")` from `extensions/lib/backend.ts`
3. Document it in `docs/architecture.md` and this README

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
