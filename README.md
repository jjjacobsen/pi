# pi

All of my custom pi stuff: extensions, skills, and config. The goal is a
minimal personal setup. Extensions run directly in pi as TypeScript modules
and stay small. The repo includes in-house extensions and selected work from
people and organizations I trust

## Setup on a new machine

1. `git clone git@github.com:jjjacobsen/pi.git` and `cd` in
2. `mise trust`, then `mise use -g pi@latest` to install pi
3. `pi install ~/Projects/pi` to load this repo's extensions, prompts, and skills, then restart pi
4. Run `/login` to authenticate your model provider, then `/model` to select a model
5. Merge the [personal pi settings](docs/pi-settings.md) into `~/.pi/agent/settings.json`

See [environment and dependencies](docs/environment.md) for feature-specific API
keys, browser, device and audio setup, external resources, and development tools
Optional feature dependencies are not required just to run Pi

## Layout

- `extensions/` - TypeScript extension modules and shared helpers
- `prompts/` - slash-command templates
- `skills/` - package skills
- `docs/` - design notes, including [installed-packages.md](docs/installed-packages.md)
- `package.json` - load this repo into pi with `pi install /path/to/this/repo`

Technical details for every extension live in [docs/architecture.md](./docs/architecture.md)

## Extensions

### browser - delegated browser tasks

Use `/browser-model` or `/browser-model provider/model` to save the worker
model. Use `/browser-thinking` or `/browser-thinking level` to save its thinking
level. Select a model first. These settings persist across sessions and do not
change the main session model

`browser` takes one `task` string. The worker uses agent-browser CLI through
bash and returns its final report. Include URLs, inputs, authorization,
applicable user/project rules, and success conditions because the worker does
not see the main conversation

```text
browser({task: "Open https://example.com and report the page title"})
```

The plain agent-browser CLI uses its native configuration and environment.
By default, the browser uses a temporary profile, not your daily browser, and
starts on the first CLI browser command. It is shared across pi sessions. The
worker closes the current browser session when the task is complete, unless
you ask to keep it open. It stays open when the task needs user input, an answer
to a question, login, or another manual browser action. The worker reports what
is needed to continue. Session changes, forks, reload, and shutdown do not close it

`/browser-close` stops only this extension's active worker, then runs
`agent-browser close --all` with native semantics. This can close browsers used
by other pi sessions. The standalone dashboard stays running

`/browser-dashboard` opens the local dashboard only for an existing default
shared browser. It takes no arguments and does not start a browser if none is open

```text
/browser-dashboard
/browser-close
```

Reports use PASS, FAIL, or BLOCKED with observed evidence. For requested visual
checks or screenshot evidence, include permission and any capture constraints in
the task. The worker publishes saved screenshot paths and a preview of the first
image, capped at 1024 pixels per side and 1 MB. Original files stay unchanged

Worker usage counts toward pi's session totals, including failed and cancelled
runs. Task inputs and page data go to the selected model's provider. Published
screenshot previews also go to the worker and main model providers

Browser setup is adapted from [Vercel's agent-browser skill](https://github.com/vercel-labs/agent-browser/tree/main/skill-data/core)

### device - delegated Android emulator tasks

Use `/device-model` or `/device-model provider/model`, then `/device-thinking`
or `/device-thinking level`. These settings persist across sessions, separate
from the browser worker and main model. `/model-settings` includes this worker

`device` takes an explicit `target` emulator ADB serial and a complete `task`
with the app package, inputs, authorization, applicable user/project rules,
and expected results. Only dedicated Android emulators are supported, not
physical phones. The worker uses [Callstack's agent-device](https://github.com/callstack/agent-device)
CLI, inspects current state, and returns a concise PASS, FAIL, or BLOCKED report
It leaves the app, emulator, and CLI session running, including Flutter apps
and their development connections. It does not boot or prepare devices

```text
device({target: "emulator-5554", task: "On this authorized dedicated emulator, inspect com.example.app and verify the sign-in screen. Leave it running"})
```

Snapshots can install or update agent-device's bundled helper APK on the
specified emulator. This does not permit other software installs. The normal
keyboard stays in use. Screenshots are available when task rules permit them
Published screenshot paths and the first reduced preview return to the caller,
using the same limits as browser evidence. Task data and previews go to the
worker and main model providers. Usage counts toward session totals

Install the shared CLI and prepare the emulator before use. See
[environment dependencies](docs/environment.md). Run `/reload` after adding this
extension, then select its model. The package's `./extensions` registration
loads it without a separate settings entry

### commit - AI commit messages

`/commit` stages everything and requires a Conventional Commit message, using
commit guidance from root `AGENTS.md` and `CLAUDE.md`, the current branch, and
session context. It does not use commit history for style. It stops before
staging while `goal.md` or `handoff.md` exists in the repository root, and it
refuses to commit if the staged snapshot changes while it writes the message

The `commit` tool uses this same workflow when you ask Pi to commit, including
requests such as "do the work then commit". It never commits without a user
request and never pushes. Its optional `intent` string accepts the same
`[CAS-1234] [intent]` arguments as `/commit`. It stages all changes, so Pi must
check that scope first and must not remove blocking files just to bypass it.
The result reports the short commit hash and header, or that nothing changed

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
The picker and settings writes are shared with subagent, browser, device, and commit

Pi 1.4.0 still sends image-only OpenRouter models to Chat Completions. A small
registered provider adapter sends them to OpenRouter's Images API and preserves
Pi's client identity headers. The selected model does not change
The custom Vercel integration and `/image-thinking` are removed because Pi has
no native image-thinking control. It uses existing Pi credentials and the
selected provider's billing, not Codex subscription usage. Usage counts toward
session totals. See [docs/imagegen.md](docs/imagegen.md) for setup and limits

### lazygit - full-screen git TUI via /lg

`/lg` hands the whole terminal to lazygit while pi keeps running in the
background, so you can browse commits and stage diffs

### model-settings - worker model overview

`/model-settings` shows the global pi default model and thinking level, plus
settings for subagent, browser, device, commit, and imagegen. The image row checks Pi's
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

### status - provider limits and balances via /status

`/status` shows live OpenAI Codex and OpenCode Go quota limits, plus the X
balance in USD using `X_BEARER_TOKEN`. Missing credentials or request errors
show under that provider without blocking the others. It does not collect
session usage or write a cache. The view is adapted from omp (can1357/oh-my-pi)

### footer - custom status footer via /footer

The custom footer shows your workspace, git branch and status (`↑N ↓N` upstream
ahead / behind commits and `*N ?N +N` worktree-changed / untracked / staged
counters, polled from `git status`), a browser icon when any agent-browser daemon
is live, token and cost stats, the latest response's cache hit percentage (`CH`), and
a context color set on absolute tokens (warning ~100k, error ~200k). Totals
include cache-warming usage. `/footer`
switches between it and the built-in footer. Browser status has no count or `?`
indicator. A failed status scan hides the icon
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
3. Update `docs/environment.md` if it needs an external command, service, credential, or environment setting

## Prompts

The `prompt-input` extension preserves newlines, indentation, and literal quotes
in input to this package's argument-based templates. No special quoting is needed. Template
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

### fix-stack - repair a stacked PR chain

`/fix-stack [PR link or additional instructions]` finds the stack from the
current top branch, resolves upstream conflicts from bottom to top,
and checks each repaired branch. It creates local backup refs before rewriting
history and asks before pushing unless you explicitly request a push

### worktree - work alongside another agent

`/worktree [task]` keeps the current working directory read-only and requires
an external worktree on a new branch before writes. Commits and pushes still
require an explicit request. This is an instruction template, not an enforced
sandbox

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
