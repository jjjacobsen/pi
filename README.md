# pi

All of my custom pi stuff: extensions, skills, and config. The goal is a
minimal personal setup, not a rule that every extension is mine. Most
extensions are built in house, piece by piece: writing them in Zig is how
I learn the language, and keeping them minimal means no third-party bloat.
Extensions run with a lot of power, so code from an untrusted person is an
easy place to slip something dangerous in. A few extensions from people or
orgs I know and trust are welcome when rewriting them myself adds no value

## Setup on a new machine

1. `git clone git@github.com:jjjacobsen/pi.git` and `cd` in
2. `mise trust` then `mise install` to pull the pinned tools (zig, hk, ...)
3. `curl -fsSL https://bun.sh/install | bash` to install bun
4. `bun install -g @earendil-works/pi-coding-agent` to install pi
5. `mise run build` to compile the extension binaries into `zig-out/bin`
6. `brew install lightpanda-io/browser/lightpanda`
7. `mise run daemon-start` - renders the LaunchAgent plist into
   `~/Library/LaunchAgents/com.pijon.lightpanda.plist` and starts the daemon.
   Confirm with `mise run daemon-status`
8. Install the packages into pi, then restart pi
   - `pi install ~/Projects/pi` (this repo: extensions, prompts, skills)
   - `pi install git:git@github.com:earendil-works/pi-transcribe`
   - `pi install npm:@ff-labs/pi-fff`
9. Export `EXA_API_KEY` before starting pi (the search extension needs it)

## Layout

- `extensions/` - TypeScript glue that connects pi to the Zig backends
- `src/` - the Zig backends, one binary per extension, built by `build.zig`
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
exists in the repository root

### lightpanda - headless browser

Gives the model a real headless browser with tools to navigate, read,
click, fill forms, and extract content from any page. All pi processes
share one persistent tab by default; a pi process can be pointed at its
own tab (browser_pick_session) and tabs can be listed and closed.
Needs the lightpanda daemon running (`mise run daemon-start`), see
docs/daemons.md

### lazygit - full-screen git TUI via /lg

`/lg` hands the whole terminal to lazygit (while pi keeps running in the
background), so you can browse commits and stage diffs the old-fashioned way

### nvim - full-screen neovim via /nvim

`/nvim` hands the whole terminal to neovim in the session cwd (`/nvim
<path>` opens elsewhere) and quits back to pi with `:q`, written exactly like
lazygit

### peon - Warcraft sounds via /peon

Plays Warcraft 3 orc peon and human peasant voice lines when things
happen, like session start or task complete. `/peon` opens the settings
panel to adjust volume and which events make noise. Replaces the
third-party pi-peon-ping extension

### usage - usage dashboard via /usage

`/usage` shows how many tokens and dollars you've burned, with graphs,
tables, and provider quota bars. Replaces
`@tmustier/pi-usage-extension`; the limits view is adapted from
omp (can1357/oh-my-pi)

### footer - custom status footer via /footer

Replaces pi's status bar with an opencode-style footer showing your
workspace, git branch + status (omp-style `*N ?N +N` worktree-changed /
untracked / staged counters, polled from `git status`), token/cost stats,
and a context color set on absolute tokens (warning ~100k, error ~200k)
instead of window percentage. `/footer` switches back to the built-in

### vision - image analysis via a vision model

`describe_image` lets a text-only model see images by handing them to a
configured vision model. `/vision show` and `/vision model <provider/model>`
pick the model. Replaces `@getpipher/vision`

### search - web search via the Exa API

`web_search` queries Exa with your `EXA_API_KEY` and hands back numbered
sources the model can cite. Replaces pi-web-access and the original
Codex-backed search

### subagent - isolated task delegation

`subagent` hands a meaty, self-contained task to an isolated sub-session
in the same process and returns only its final summary, so the caller's
context window stays low. The subagent gets `read`/`bash`/`edit`/`write`
plus `web_search` and `describe_image`, and can be called several times in
one turn to run tasks in parallel. Model and reasoning inherit independently
from the caller unless a call sets either optional override. Its full
transcript is saved under the agent dir
(`~/.pi/agent/subagents/`), is resumable, and its usage counts toward
`/usage` in the caller's session. Pure TypeScript via pi's SDK, no Zig
backend, see docs/architecture.md

## Adding a new extension

1. Write the backend in `src/foo.zig` and add it to `bins` in `build.zig`
2. Write `extensions/foo.ts` glue that calls the binary via the shared
   `callZig` helper (see `extensions/search.ts`)
3. Document it in `docs/architecture.md` and this README

## Prompts

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

### repo-audit - whole-repo improvement audit

Scans the whole repo for over-engineering, dead code, duplication, and
other problems, then lists what to fix ranked by impact. Adapted from the
ponytail-audit skill of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
