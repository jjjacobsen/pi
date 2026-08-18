# pi

All of my custom pi stuff: extensions, skills, and config. The goal is
zero dependence on third-party pi extensions; everything here is built in
house, piece by piece

## Layout

- `extensions/` - TypeScript extension entry points (pi requires TS modules);
  `extensions/lib/backend.ts` is the shared stdio bridge all of them use.
  Backends start lazily (importing spawns nothing; the first call starts the
  binary), rebuild binaries when sources changed (stamped in
  `zig-out/.pi-build-stamp.json`, so at most once per edit), respawn only
  after the old child exits (Esc aborts, crashes), and tear backends down
  at session boundaries (`session_shutdown` via `handleSessionShutdown`):
  kill on host teardown (quit/reload), so `/reload` picks up Zig and TS
  changes with no orphaned processes, and reset on session replacement
  (`/new`, `/resume`, `/fork`), killing the child and respawning fresh so
  no in-memory state bleeds into the new session
- `extensions/lib/toolkit.ts` - shared tool glue for the HTTP-delegating
  extensions (search, vision): `withAbort` (Esc kills and respawns the
  backend), `toolError` (throws, since pi only treats thrown errors as tool
  failures), and `toToolUsage` (turns backend token accounting into
  `AgentToolResult.usage` with cost from the model's pricing)
- `tsconfig.json` - editor and hk typechecking only, no local `node_modules`.
  `paths`/`typeRoots` point at the live global pi install
  (`~/.bun/install/global/node_modules`) so the extension types always match
  the running pi; pi itself resolves the `@earendil-works/*` imports at
  runtime from its own loader. `hk.pkl` runs the `tsc` builtin
  (`tsc --noEmit -p tsconfig.json`) on any TS change; details in
  docs/architecture.md
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
Extracted results are capped at 256KB (head/tail kept) so one call cannot
flood context, and Esc aborts an in-flight call by restarting the backend
(the loaded page is lost).
See [docs/architecture.md](docs/architecture.md).

```sh
mise check        # build + self-check (needs `lightpanda` on PATH)
```

### cua - desktop computer use via Cua Driver

`extensions/cua.ts` + `src/cua.zig`. Gives the model 19 `computer_*` tools
(list/launch apps, window snapshots with AX element trees, full-screen and
cropped screenshots, click/double/right-click, type, press key, hotkey,
scroll, cursor, kill) that drive the host desktop through
[trycua/cua](https://github.com/trycua/cua)'s `cua-driver` CLI, targeting
windows without moving the system cursor. Screenshots are written to
`~/.pi/agent/cua-screenshots/` and viewed through the existing
describe_image vision tool (the model decides when pixels are worth
vision tokens). Every `get_window_state` tree row carries its
`element_token` and the snapshot_id is surfaced, so tree-driven clicks
(`element_token` or `element_index + snapshot_id`) work with no pixels;
screenshots are only needed for canvas surfaces the AX tree does not
cover. Requires the CuaDriver daemon with Accessibility + Screen
Recording granted. Self-check runs against a fake `cua-driver` script, so
`mise check` passes without the daemon.
See [docs/architecture.md](docs/architecture.md).

### lazygit - full-screen git TUI via /lg

`extensions/lazygit.ts` + `src/lazygit.zig`. The `/lg` command pauses the pi
TUI and hands the whole terminal to lazygit, exactly like lazygit.nvim does
over nvim: it validates the target is a git repo and lazygit is on PATH, stops
pi's renderer, spawns lazygit on `/dev/tty`, then resumes and reports the exit
status. See [docs/architecture.md](docs/architecture.md).

### goal - autonomous goal loop via /goal

`extensions/goal.ts` + `src/goal.zig`. The `/goal` command runs the agent
autonomously: `/goal <objective> [--min-time 1h] [--max-time 1h] [--min-tokens 100k] [--max-tokens 100k] [--no-ask]`, plus `/goal status | pause | resume | clear`. The Zig backend owns the whole state machine: min/max time and token boundaries, automatic continuation turns, a no-progress guard, error tolerance (transient provider errors retry; the goal pauses only after 3 consecutive errored runs), stale-turn-safe goal_complete / goal_blocked / goal_wait tools, and it never asks questions mid-run. `--no-ask` removes even start-time questions for full automation. See [docs/architecture.md](docs/architecture.md).

### peon - Warcraft peon sounds via /peon

`extensions/peon.ts` + `src/peon.zig`. Plays random orc peon and human peasant voice lines on pi events: session start, task acknowledge, task complete, task error, and rapid prompt spam. `/peon` opens the settings panel (volume, silent window, per-category toggles). The 33 wavs are embedded in the binary, config lives in `~/.pi/agent/peon.json`, and all decisions live in Zig. Replaces the third-party pi-peon-ping extension (no pack picker, relay, desktop notifications, or preview sound). See [docs/architecture.md](docs/architecture.md).

### usage - usage dashboard via /usage

`extensions/usage.ts` + `src/usage.zig`. The `/usage` command shows usage stats for Today / This Week / Last Week / Last 30 Days / All Time across four views: Graphs (braille charts by provider/model/thinking, cumulative toggle), Table (providers to models, filter/hide/expand), Insights (cost advice), and Limits (provider quota: OpenAI Codex subscription and OpenCode Go 5h/weekly/monthly windows with usage bars, reset timers, plan/account info, Codex saved resets). All data collection runs in the Zig backend: session JSONL scanning with a binary cache, aggregation, insights, and the quota fetches. Delegated tool usage (describe_image, web_search) is counted under the Tools provider; Codex credentials for the limits fetch come from pi's model registry (no auth.json handling in Zig), and the Limits view fetches only when first opened. Replaces the third-party `@tmustier/pi-usage-extension`; the limits view is adapted from omp (can1357/oh-my-pi). See [docs/architecture.md](docs/architecture.md).

### footer - custom status footer via /footer

`extensions/footer.ts`. Pure TS, no Zig backend. Replaces pi's built-in footer with an opencode-style two-line footer: `π  ~/Projects/pi  main` workspace line on top (nerd font icons), token/cost/context stats on the bottom with the model and reasoning level right-aligned (context shown as absolute tokens over the window, e.g. `38,234/1.0M`, compaction-aware: `?/1.0M` right after /compact until the next response). Drops the built-in footer's R (cache read), W (cache write), CH (cache hit %) and (auto) compaction segments, and adds a tok/s readout (estimated from streamed characters; always visible, reset to 0.0 at session start, live while streaming and frozen at the last value when idle, placed last so the line never shifts) and an always-visible cost segment starting at $0.000 before the first billed response. Enabled automatically at session start; `/footer` toggles back to the built-in footer. See [docs/architecture.md](docs/architecture.md).

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
endpoint with one retry and a hard deadline. The delegated tokens and cost
are reported as tool-result usage, so /usage counts them. Multimodal models never see the
tool — pi passes images to them natively. `/vision show` and
`/vision model <provider/model>` configure the vision model. Replaces the
third-party @getpipher/vision package. See
[docs/architecture.md](docs/architecture.md).

### search - web search via the Exa API

`extensions/search.ts` + `src/search.zig`. The `web_search` tool queries
Exa with the `EXA_API_KEY` from your shell environment and returns a
numbered source list with excerpts: the model writes the answer and cites
sources as `[n]` markers into the list. Mode `answer` (default) returns
sources with longer excerpts for synthesis; mode `results` returns only a
compact list, faster and cheaper. One retry on transient failures, a 30s
deadline, Esc aborts, domain and recency filters, and the per-search cost
is reported so /usage counts it. Replaces the third-party pi-web-access
package (uninstalled) and the original Codex-backed search. See
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
