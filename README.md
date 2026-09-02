# pi

All of my custom pi stuff: extensions, skills, and config. The goal is a
minimal personal setup. Extensions run directly in pi as TypeScript modules
and stay small. The repo includes in-house extensions and selected work from
people and organizations I trust

## Setup on a new machine

1. `git clone git@github.com:jjjacobsen/pi.git` and `cd` in
2. `mise trust` then `mise install` to pull the pinned development tools
3. `curl -fsSL https://bun.sh/install | bash` to install bun
4. `bun install -g @earendil-works/pi-coding-agent` to install pi
5. Install the packages into pi, then restart pi
   - `pi install ~/Projects/pi` (this repo: extensions, prompts, skills)
   - `pi install git:git@github.com:earendil-works/pi-transcribe`
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

### commit - AI commit messages

`/commit` stages everything and writes a conventional commit message in
your repo's style, using your git history, AGENTS.md, and the current
session for context. It stops before staging while `goal.md` or `handoff.md`
exists in the repository root, and it refuses to commit if the staged snapshot
changes while it writes the message

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
`afplay` on macOS or PipeWire's `pw-play` on Linux/Omarchy. Adapted from the
third-party `pi-peon-ping` extension

### status - provider limits via /status

`/status` shows live OpenAI Codex and OpenCode Go quota limits. It does not
collect session usage or write a cache. The view is adapted from omp
(can1357/oh-my-pi)

### footer - custom status footer via /footer

The custom footer shows your workspace, git branch and status (`*N ?N +N`
worktree-changed / untracked / staged counters, polled from `git status`), an
icon and count when Playwright CLI browsers are open, token and cost stats, and
a context color set on absolute tokens (warning ~100k, error ~200k). `/footer`
switches between it and the built-in footer.
The design takes inspiration from opencode and omp
(can1357/oh-my-pi)

### vision - image analysis via a vision model

`describe_image` lets a text-only model see images by handing them to a
configured vision model. `/vision show` and `/vision model <provider/model>`
pick the model. Adapted from `@getpipher/vision`

### search - web search via the Exa API

`web_search` queries Exa with your `EXA_API_KEY` and hands back numbered
sources the model can cite. Adapted from `pi-web-access` and the earlier
Codex-backed search

### subagent - isolated task delegation

`subagent` hands a meaty, self-contained task to an isolated sub-session
in the same process and returns only its final summary, so the caller's
context window stays low. The subagent gets `read`/`bash`/`edit`/`write`
plus `web_search` and `describe_image`, and can be called several times in
one turn to run tasks in parallel. Model and reasoning inherit independently
from the caller unless a call sets either optional override. Tasks are passed
literally, and failed or empty final responses fail the tool with the transcript
path. Its full transcript is saved under the agent dir
(`~/.pi/agent/subagents/`), is resumable, and its usage counts toward pi's
session totals. See [docs/architecture.md](docs/architecture.md) for the
implementation details

## Adding a new extension

1. Write `extensions/foo.ts` using pi's extension SDK and the shared helpers
   in `extensions/lib/` when useful
2. Document it in `docs/architecture.md` and this README

## Prompts

### handoff - save session context

`/handoff` writes the current goal, state, decisions, validation, blockers, and
next steps to `handoff.md` so a new session can continue the work

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

### browser - deterministic browser automation

Controls a Playwright-managed browser through compact accessibility snapshots
and element references. It runs headless with one persistent managed profile by
default, writes generated output under `~/.pi/agent/playwright/`, and uses a
visible browser only for a manual authentication handoff.
Adapted from the official [Microsoft Playwright CLI skill](https://github.com/microsoft/playwright-cli)

### repo-audit - whole-repo improvement audit

Scans the whole repo for over-engineering, dead code, duplication, and
other problems, then lists what to fix ranked by impact. Adapted from the
ponytail-audit skill of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
