# pi

All of my custom pi stuff: extensions, skills, and config. The goal is a
minimal personal setup. Extensions run directly in pi as TypeScript modules
and stay small. The repo includes in-house extensions and selected work from
people and organizations I trust

## Setup on a new machine

1. `git clone git@github.com:jjjacobsen/pi.git` and `cd` in
2. `mise trust` then `mise install` to pull the pinned development tools
3. `mise use -g pi@latest` to install pi
4. `mise use -g npm:agent-browser@0.38.1` to install agent-browser for the browser skill. Install system Chromium separately, available on PATH or through `AGENT_BROWSER_EXECUTABLE_PATH`
5. Install the packages into pi, then restart pi
   - `pi install ~/Projects/pi` (this repo: extensions, prompts, skills)
   - `pi install npm:@ff-labs/pi-fff`
6. Export `EXA_API_KEY` before starting pi (the search extension needs it)

## Layout

- `extensions/` - TypeScript extension modules and shared helpers
- `prompts/` - slash-command templates
- `skills/` - package skills
- `docs/` - design notes, including [installed-packages.md](docs/installed-packages.md)
- `package.json` - load this repo into pi with `pi install /path/to/this/repo`

Technical details for every extension live in [docs/architecture.md](docs/architecture.md)

## Extensions

### bar cursor - terminal bar cursor in the editor

Replaces pi's inverted software block with a steady hardware bar cursor while
the input editor is active. It keeps pi's working, compaction, summary, and
retry indicators in the editor border. The terminal must support the standard
DECSCUSR cursor-shape sequence

### browser - delegated browser tasks with a separate model

`/browser-model` opens a scrolling, searchable picker of your configured pi
models and saves the selection for all sessions. `/browser-model provider/model`
selects it directly. `/browser-thinking` selects a supported thinking level, or
use `/browser-thinking low` directly. Neither changes the main session settings.
The `browser` tool takes a starting URL and a
self-contained task, then runs a bounded headless worker with the existing
persistent automation profile. Startup opens only the task tab, without an extra
New Tab page. For a user-requested viewing session, pass
`visible: true` to show and leave the browser open. After an explicit login
handoff, also pass `reuseSession: true` to reuse that visible session

The worker uses text and accessibility refs only. It has no shell, eval,
screenshots, or coordinate controls. It stops for login, approval, or unsupported
steps. Use the browser skill for those handoffs. Do not run browser tasks in parallel

`/browser-mode jev` enables experimental bounded action selection with Jev
and requires `TYPESAFE_API_KEY`. `/browser-mode fast` uses the fast worker alone
and is the default. The tool's `mode` parameter can override this for comparison.
Jev selects current-page actions at a 0.9 confidence cutoff. Supply exact,
nonsecret form values through `inputs`, keyed by field meaning, such as
`{"Full name": "Morgan Example", "Online attendance": true}`. Jev can use these
values without a text-generation call. The fast model handles missing values,
uncertainty, and final reports. High-confidence completion switches to read-only
verification. The cutoff and approval instructions are not a security guarantee

Each result includes status, page evidence, total/model/browser/Jev time,
completion detection, report and cleanup timing, action and decision counts,
tokens, and estimated cost. Completion timing is a model judgment, not an
independent success check. Usage counts toward
pi's session totals. Cost is an estimate, not a bill. Page data goes to the
selected model provider and, in Jev mode, TypeSafe. The Jev pattern is adapted
from [TypeSafe's function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling)
and [OpenCode's Jev loop](https://github.com/anomalyco/opencode/blob/021f8b3202a8027b684e43a2e673c269becaf156/packages/plugin-browser/src/use.ts)

### commit - AI commit messages

`/commit` stages everything and writes a conventional commit message in
your repo's style, using your git history, AGENTS.md, and the current
session for context. It stops before staging while `goal.md` or `handoff.md`
exists in the repository root, and it refuses to commit if the staged snapshot
changes while it writes the message

### imagegen - image generation with a separate model

`/image-model` opens a searchable picker of live image-output models from your
configured OpenRouter and Vercel AI Gateway providers. The selection is saved
for all sessions and does not change your coding model. `imagegen` generates
images or edits local references, saves original files, and returns a preview

It uses existing pi credentials and the selected provider's billing, not Codex
subscription usage. OpenCode Go is not offered because image output is not
documented. See [docs/imagegen.md](docs/imagegen.md) for setup and limits

### lazygit - full-screen git TUI via /lg

`/lg` hands the whole terminal to lazygit while pi keeps running in the
background, so you can browse commits and stage diffs

### nvim - full-screen neovim via /nvim

`/nvim` hands the whole terminal to neovim in the session cwd (`/nvim
<path>` opens elsewhere) and quits back to pi with `:q`

### peon - Warcraft sounds via /peon

Plays Warcraft 3 orc peon and human peasant voice lines when things
happen, like session start or task complete. `/peon` opens the settings
panel to adjust volume and which events make noise. Audio plays through
PipeWire's `pw-play`. Adapted from the third-party `pi-peon-ping` extension

### status - provider limits via /status

`/status` shows live OpenAI Codex and OpenCode Go quota limits. It does not
collect session usage or write a cache. The view is adapted from omp
(can1357/oh-my-pi)

### footer - custom status footer via /footer

The custom footer shows your workspace, git branch and status (`↑N ↓N` upstream
ahead / behind commits and `*N ?N +N` worktree-changed / untracked / staged
counters, polled from `git status`), an icon and count for active agent-browser
sessions, token and cost stats, and
a context color set on absolute tokens (warning ~100k, error ~200k). Totals
include cache-warming usage. `/footer`
switches between it and the built-in footer.
The design takes inspiration from opencode and omp
(can1357/oh-my-pi)

### search - web search via the Exa API

`web_search` queries Exa with your `EXA_API_KEY` and hands back numbered
sources the model can cite. Adapted from `pi-web-access` and the earlier
Codex-backed search

### subagent - isolated task delegation

`subagent` hands a meaty, self-contained task to an isolated sub-session
in the same process and returns only its final summary, so the caller's
context window stays low. The subagent gets `read`/`bash`/`edit`/`write`
plus `web_search` and can be called several times in
one turn to run tasks in parallel. Model and reasoning inherit independently
from the caller unless a call sets either optional override. Tasks are passed
literally, and failed or empty final responses fail the tool with the transcript
path. Its full transcript is saved under the agent dir
(`~/.pi/agent/subagents/`), is resumable, and its complete usage, including
tools, compaction, and cache warming, counts toward pi's session totals. See
[docs/architecture.md](docs/architecture.md) for the implementation details

## Adding a new extension

1. Write `extensions/foo.ts` using pi's extension SDK and the shared helpers
   in `extensions/lib/` when useful
2. Document it in `docs/architecture.md` and this README

## Prompts

### handoff - save session context

`/handoff` writes the current goal, state, decisions, validation, blockers, and
next steps to `handoff.md` so a new session can continue the work. Any text
following `/handoff` appears first, followed by a blank line and the handoff
instructions, the same as `/q`

### q - question only

`/q` expands into an instruction telling the model not to change anything,
then passes through whatever you type after it

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

### browser - deterministic browser automation

Uses agent-browser with system Chromium resolved through PATH or
`AGENT_BROWSER_EXECUTABLE_PATH`. Runs headless by default with a separate
persistent profile at `~/.pi/agent/browser/profile`. Login state survives browser
restarts. The daily browser profile is never used

Uses compact accessibility snapshots and element references, never screenshot
navigation or coordinate clicks. Visible operation supports manual login and
headless troubleshooting. After manual login, the browser can restart headless
with the same profile. No changes to the normal browser's remote debugging are needed

Browser tasks run one at a time through the named `browser` session. The footer
counts active agent-browser sessions. Tasks close the browser when done, with a 10-minute
idle timeout as a backstop. Explicit output files go under `~/.pi/agent/browser/`

Adapted from [Vercel's agent-browser skill](https://github.com/vercel-labs/agent-browser/tree/main/skill-data/core)

### pi-upgrade - review and synchronize pi upgrades

Compares the installed pi release with this repository's development version,
reads every intervening changelog section, and checks affected extensions and
skills. It adapts relevant code, synchronizes the three pi development
packages, updates documentation, and runs all repository checks

### repo-audit - whole-repo improvement audit

Scans the whole repo for over-engineering, dead code, duplication, and
other problems, then lists what to fix ranked by impact. Adapted from the
ponytail-audit skill of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
