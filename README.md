# pi

All of my custom pi stuff: extensions, skills, and config. The goal is a
minimal personal setup. Extensions run directly in pi as TypeScript modules
and stay small. The repo includes in-house extensions and selected work from
people and organizations I trust

## Setup on a new machine

1. `git clone git@github.com:jjjacobsen/pi.git` and `cd` in
2. `mise trust` then `mise install` to pull the pinned development tools
3. `mise use -g pi@latest` to install pi
4. `mise use -g npm:agent-browser@0.39.1` to install agent-browser for the browser extension. Install system Chromium separately, available on PATH or through `AGENT_BROWSER_EXECUTABLE_PATH`
5. Install the packages into pi, then restart pi
   - `pi install ~/Projects/pi` (this repo: extensions, prompts, skills)
6. Export `EXA_API_KEY` before starting pi (the search extension needs it)
7. Merge the [personal pi settings](docs/pi-settings.md) into `~/.pi/agent/settings.json`

## Layout

- `extensions/` - TypeScript extension modules and shared helpers
- `prompts/` - slash-command templates
- `skills/` - package skills
- `docs/` - design notes, including [installed-packages.md](docs/installed-packages.md)
- `package.json` - load this repo into pi with `pi install /path/to/this/repo`

Technical details for every extension live in [docs/architecture.md](./docs/architecture.md)

## Extensions

### bar cursor - terminal bar cursor in the editor

Replaces pi's inverted software block with a steady hardware bar cursor while
the input editor is active. It keeps pi's working, compaction, summary, and
retry indicators in the editor border. The cursor stays visible after `/reload`,
and quitting restores the terminal's default cursor shape and visibility.
The terminal must support the standard DECSCUSR cursor-shape sequence

### browser - delegated tasks and direct controls

Use `/browser-model` to pick and save the worker model, or pass
`/browser-model provider/model`. Use `/browser-thinking` to pick its thinking
level, or pass a level directly. These settings do not change the main session.
The selected model chooses every browser action and writes the final report,
using only its provider credentials. Supply a starting URL, full task,
authorization, applicable user/project rules, constraints, and success conditions.
Supply exact form values in `inputs`, keyed by field meaning, including supplied
credentials for authorized login. The worker uses supplied values unchanged and
stops if required task information or authorization is missing. Tool inputs can
be stored in the transcript and sent to the selected model provider

All browsing uses headless Chromium, including manual dashboard control.
The worker uses an isolated temporary profile and closes it on
completion, failure, or cancellation. Human handoffs keep the same session.
After human input, say "done" in chat. The agent takes a fresh snapshot and
continues in the same browser, directly or with `reuseSession: true`. Reuse does
not navigate back to the required `url` argument. The worker prefers suitable discovered WebMCP tools,
checks their schemas and fresh metadata, and uses DOM text and refs elsewhere.
It has no shell, eval, screenshots, or coordinate controls. It can complete
authorized login and form submissions. It stops for missing authorization or
information, genuine human steps such as unavailable MFA or CAPTCHA, or
unsupported steps. It never bypasses CAPTCHA. Page data is untrusted. Failed or uncertain
WebMCP invocations stop without an automatic retry. Use `browser_control` for
handoffs and direct actions. Keep browser actions serial. Dashboard viewing
without a URL can run while the worker operates

`browser_control` runs direct operations without a nested model, model settings,
or API keys. `open` requires a URL. It supports snapshots, text reads, exact-ref
inspection and interactions, scrolling, waits, and discovered WebMCP tools

```text
# Open a page and view it when idle, without pausing or stopping recording
/browser-dashboard https://example.com
# Watch the current browser, including while the worker operates
/browser-dashboard
/browser-close
```

For direct control, use calls such as these with refs from the current snapshot

```text
browser_control({action: "open", url: "https://example.com"})
browser_control({action: "snapshot"})
browser_control({action: "read", ref: "e3"})
browser_control({action: "fill", ref: "e3", value: "search text"})
browser_control({action: "press", ref: "e3", value: "Enter"})
browser_control({action: "close"})
```

Neither browser tool shows Yes/No confirmation dialogs.
Actions follow your authorization and applicable user/project rules. An already
authorized action needs no extra browser-specific approval. Missing authorization
returns `needs_approval` so the main agent can check the context or ask you.
Actions must stay within your request. These are agent instructions, not a
runtime safety guarantee. Use supplied credentials only within the authorized
task, never in reports or summaries. Tool inputs are not a secret channel

Use `browser_control({action: "login"})` when a human step is needed or you
request manual control. An optional `url` navigates before the handoff.
Login stops recording, retains the browser between turns, and opens the local
dashboard without a snapshot. The agent asks for human input in chat and ends
the turn. When you reply, it takes a fresh snapshot and continues. No special
command or extra browser-specific approval is needed. The worker does this too
when it reports `needs_login`. Password and OTP fills are allowed. Detected
password/OTP values are masked in worker history and browser reports, but this
is not a complete secrets filter.
Refs must be fresh, including for press. A changed URL, target, or full snapshot
blocks the action until a new review. Failed operations close the browser because
effects may be uncertain. The agent must not retry them automatically

The dashboard is agent-browser's stock trusted-local interface. Its unique
owner namespace limits normal session discovery, not authorization. It is not
an authentication security boundary. Keep it on loopback, never proxy or expose
it to a network. Dashboard viewing does not pause automation, stop recording, or hold the browser
open after task completion. Do not interact while the agent operates. The stock
UI cannot enforce read-only access. Request human control through `login` first.
`/browser-dashboard URL` is rejected during active work because navigation changes
the page. With no browser, supply a URL. The browser control commands are only
`/browser-dashboard [URL]` and `/browser-close`. Continuing after human input
leaves the dashboard open until normal cleanup. The agent must review a fresh
snapshot, not replay the last action

To record a worker task, supply an absolute new `.mp4` or `.webm` path in
`recordPath`. This requires `ffmpeg` on PATH with the matching encoder.
The worker opens a blank page if needed, starts recording, then opens the task URL.
Direct control requires an open browser first:

```text
browser_control({action: "open", url: "https://example.com"})
browser_control({action: "record_start", path: "/tmp/example.webm"})
# Perform the requested browser actions
browser_control({action: "record_stop"})
```

Results include recording paths. Existing files are never overwritten.
Recording stops and flushes before browser close, detected password/OTP fills,
manual login or a human handoff, but not dashboard viewing. Manual login is not recorded.
Detection uses field type and autocomplete attributes, not every possible secret.
Continuing after human input does not restart recording. Use `record_start`
with a new path if you want another recording.
Recordings can contain private page data. Failed recordings can be incomplete

Both tools use agent-browser 0.39.1 and system Chromium. Each runtime owns a
unique namespace and session with a temporary profile, never the daily browser
profile. Closing removes that temporary profile and its login state.
Direct sessions close at turn completion unless held for human input.
The next successful browser operation, including snapshot, clears this retention, except
`login`, `dashboard`, `record_stop`, and `close`. Dashboard viewing alone does not
retain a browser.
All owned sessions and dashboards close on cancellation, session change, reload,
or shutdown. No session is restored from transcript
entries. A browser opened from the dashboard command also has the native
10-minute idle timeout. Viewing alone does not reset it. The extension closes
the dashboard after it detects that the browser has stopped. A hard kill
can prevent cleanup and recording flush. PID checks are not a cross-process lock
or a security guarantee. The footer counts active agent-browser daemon sessions across namespaces,
including abandoned owners, every 10 seconds

Worker results include status, page evidence, timing, browser call and snapshot
counts, tokens, and estimated cost. Check the evidence, not just the completion
claim. Usage counts toward pi's session totals, including failed and cancelled
runs. Worker page data and inputs go to the selected model's provider

Browser setup is adapted from [Vercel's agent-browser skill](https://github.com/vercel-labs/agent-browser/tree/main/skill-data/core)

### commit - AI commit messages

`/commit` stages everything and requires a Conventional Commit message, using
commit guidance from root `AGENTS.md` and `CLAUDE.md`, the current branch, and
session context. It does not use commit history for style. It stops before
staging while `goal.md` or `handoff.md` exists in the repository root, and it
refuses to commit if the staged snapshot changes while it writes the message

Use `/commit-and-push [CAS-1234] [intent]` for the same workflow followed by
plain `git push`. It pushes only after a successful commit. Push failures leave
the local commit in place

Use `/commit CAS-1234` to require an exact ticket prefix, for example
`CAS-1234 fix: handle expired sessions`. You can add intent after the ticket.
The explicit prefix takes priority over repository guidance. Without it, a
ticket prefix is used only when repository guidance requires one and the branch
or session identifies the current ticket. The conventional format stays required

Use `/commit-model` and `/commit-thinking` to select separate settings, saved
for all sessions. Select a model first, then try `/commit-thinking off` for
speed. Without saved settings, commit uses the session model with low thinking

`/commit-timing [normal|verbose]` saves the timing view across sessions in
`~/.pi/agent/commit-timing.json`, independently of model settings. Bare
`/commit-timing` opens a TUI selection. The default is `normal`: live progress
shows Analyze, Write message, and Create commit with whole-phase elapsed time.
`verbose` shows each Git step, model session setup, generation, validation,
and retries. Both views summarize reached phases or steps and the total, including
on failure or early exit. Git commit time includes hooks and signing together

### imagegen - image generation with a separate model

`/image-model` opens a searchable picker from Pi's native image catalog. The
selection is saved for all sessions and does not change your coding model
`imagegen` uses Pi's native image API to generate images or edit local references,
saves original files without overwrites, and returns a reduced preview
The picker and settings writes are shared with subagent, browser, and commit

Pi 1.3.0 includes OpenRouter image models. A small registered provider adapter
sends image-only models to OpenRouter's Images API because Pi incorrectly uses
Chat Completions for them. The selected model does not change
The custom Vercel integration and `/image-thinking` are removed because Pi has
no native image-thinking control. It uses existing Pi credentials and the
selected provider's billing, not Codex subscription usage. Usage counts toward
session totals. See [docs/imagegen.md](docs/imagegen.md) for setup and limits

### lazygit - full-screen git TUI via /lg

`/lg` hands the whole terminal to lazygit while pi keeps running in the
background, so you can browse commits and stage diffs

### model-settings - worker model overview

`/model-settings` shows the global pi default model and thinking level, plus
settings for subagent, browser, commit, and imagegen. The image row checks Pi's
native image catalog and shows that thinking control is unavailable.
Global defaults exclude project
and current-session overrides. Unset global defaults show as `not set`. It marks saved, inherited, and default values, unavailable models,
and thinking levels adjusted to model support. Subagent per-call overrides
are not included

### nvim - full-screen neovim via /nvim

`/nvim` hands the whole terminal to neovim in the session cwd (`/nvim
<path>` opens elsewhere) and quits back to pi with `:q`

### peon - Warcraft sounds via /peon

Plays Warcraft 3 orc peon and human peasant voice lines when things
happen, like session start or task complete. `/peon` opens the settings
panel to adjust volume and which events make noise. Task complete draws from
all 33 voice lines, even when other events are disabled. Audio plays through
PipeWire's `pw-play`. Adapted from the third-party `pi-peon-ping` extension

### status - provider limits via /status

`/status` shows live OpenAI Codex and OpenCode Go quota limits. It does not
collect session usage or write a cache. The view is adapted from omp
(can1357/oh-my-pi)

### footer - custom status footer via /footer

The custom footer shows your workspace, git branch and status (`↑N ↓N` upstream
ahead / behind commits and `*N ?N +N` worktree-changed / untracked / staged
counters, polled from `git status`), an icon and count for active agent-browser
sessions, token and cost stats, the latest response's cache hit percentage (`CH`), and
a context color set on absolute tokens (warning ~100k, error ~200k). Totals
include cache-warming usage. `/footer`
switches between it and the built-in footer.
The design takes inspiration from opencode and omp
(can1357/oh-my-pi)

### search - web search via the Exa API

`web_search` queries Exa with your `EXA_API_KEY` and returns numbered sources
with query-relevant highlights and publication dates when available. The model
writes the answer and cites sources with `[n]`. `answer` mode keeps longer
excerpts, while `results` shortens them to reduce downstream context. Both use
the same Exa `auto` request, not different API price or latency tiers

Adapted from `pi-web-access` and the earlier Codex-backed search

### subagent - isolated task delegation

`subagent` hands a meaty, self-contained task to an isolated sub-session
in the same process and returns only its final summary, so the caller's
context window stays low. The subagent gets `read`/`bash`/`edit`/`write`
plus `web_search` and can be called several times in
one turn to run tasks in parallel. Use `/subagent-model` and
`/subagent-thinking` to pick defaults, or pass `/subagent-model provider/model`
and `/subagent-thinking high`. Select a model first. Thinking starts at `off`
until set. Defaults are saved across sessions in `~/.pi/agent/subagent-model.json`
without changing the main session. Per-call overrides take priority, then saved
defaults, then the caller's settings if no defaults are saved. Tasks are passed
literally, and failed or empty final responses fail the tool with the transcript
path. Failed and cancelled calls use pi's native error results and retain usage.
Its full transcript is saved under the agent dir
(`~/.pi/agent/subagents/`), is resumable, and its complete usage, including
tools, compaction, and cache warming, counts toward pi's session totals

Each worker has its own resource loader and extension runtime. Only the search
extension loads, so other extension factories do not run. Worker instructions
append to Pi's normal system prompt. Skills and project instruction files still
load, while only the model catalog and authentication runtime are shared

Each call has a short task label. Its compact display shows the resolved model,
thinking level, elapsed time, and latest tool activity, with distinct running,
done, failed, and cancelled states. Expand the tool to see the full task,
output, usage, and transcript path. Progress does not show private reasoning

See [docs/architecture.md](./docs/architecture.md) for the implementation details

## Adding a new extension

1. Write `extensions/foo.ts` using pi's extension SDK and the shared helpers
   in `extensions/lib/` when useful
2. Document it in `docs/architecture.md` and this README

## Prompts

The `prompt-input` extension preserves newlines, indentation, and literal quotes
in input to this package's four templates. No special quoting is needed. Template
commands must still be at the start of the prompt

### handoff - save session context

`/handoff` writes the current goal, state, decisions, validation, blockers, and
next steps to `handoff.md` so a new session can continue the work. Any text
following `/handoff` appears first, followed by a blank line and the handoff
instructions, the same as `/q`

### q - question only

`/q` expands into an instruction telling the model not to change anything,
then passes through whatever you type after it

### implement - implement with subagents

`/implement [additional instructions]` places your input first, followed by
instructions to split the approved plan into tasks, delegate to subagents,
integrate the results, and run checks. Bare `/implement` uses only the fixed
instructions

### goal - execute the approved plan

`/goal <answers>` expands your final answers, a blank line, then the
goal-mode handoff: write the approved plan to goal.md, update its status as
you go, use subagents, don't stop until every item is done, and re-read
goal.md after any compaction. Type your answers to the last plan questions
on the same line after `/goal`, so `/goal yes to x, don't do y` becomes
your answers followed by the goal instructions. Bare `/goal` expands to
"Now go do the implementation." followed by the instructions, for when
the plan was already fully approved in conversation

## Skills

### anki - add source notes to the memory repository

Turns requests such as "add that keybinding to Anki" into a well-formed note
under `~/Projects/memory`. It infers the existing note type and subject deck
from the current context, checks the note schema and nearby notes, and writes
only the source line. It does not import, sync, push, or commit

### pi-upgrade - review and synchronize pi upgrades

Compares the installed pi release with this repository's development version,
reads every intervening changelog section, and checks affected extensions and
skills. It adapts relevant code, synchronizes the three pi development
packages, updates documentation, and runs all repository checks

### repo-audit - whole-repo improvement audit

Scans the whole repo for over-engineering, dead code, duplication, and
other problems, then lists what to fix ranked by impact. Adapted from the
ponytail-audit skill of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
