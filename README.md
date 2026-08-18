# pi

All of my custom pi stuff: extensions, skills, and config. The goal is a
minimal personal setup, not a rule that every extension is mine. Most
extensions are built in house, piece by piece: writing them in Zig is how
I learn the language, and keeping them minimal means no third-party bloat.
Extensions run with a lot of power, so code from an untrusted person is an
easy place to slip something dangerous in. A few extensions from people or
orgs I know and trust are welcome when rewriting them myself adds no value

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
session for context

### browser - headless browser via Lightpanda

Gives the model a real headless browser with tools to navigate, read,
click, fill forms, and extract content from any page

### cua - desktop computer use

Lets the model drive your desktop: launch apps, click, type, screenshot,
scroll, and press hotkeys, all without stealing your cursor. Needs the Cua
Driver daemon running with Accessibility and Screen Recording granted

### lazygit - full-screen git TUI via /lg

`/lg` pauses pi and hands the whole terminal to lazygit, so you can browse
commits and stage diffs the old-fashioned way

### goal - autonomous goal loop via /goal

`/goal <objective>` runs the agent on its own until the job is done or it
hits your time and token limits, never asking questions mid-run

### peon - Warcraft sounds via /peon

Plays Warcraft 3 orc peon and human peasant voice lines when things
happen, like session start or task complete. `/peon` opens the settings
panel to adjust volume and which events make noise. Replaces the
third-party pi-peon-ping extension

### usage - usage dashboard via /usage

`/usage` shows how many tokens and dollars you've burned, with graphs,
tables, cost insights, and provider quota bars. Replaces
`@tmustier/pi-usage-extension`; the limits view is adapted from
omp (can1357/oh-my-pi)

### footer - custom status footer via /footer

Replaces pi's status bar with an opencode-style footer showing your
workspace, git branch + status (omp-style `*N ?N +N` worktree-changed /
untracked / staged counters, polled from `git status`), token/cost stats,
and a context color set on absolute tokens (warning ~100k, error ~200k)
instead of window percentage. `/footer` switches back to the built-in

### btw - quick side questions via /btw

`/btw [question]` opens a side chat inside the TUI that answers your
question ELI15-style with the current model, without touching the main
conversation. Replaces `@narumitw/pi-btw`

### vision - image analysis via a vision model

`describe_image` lets a text-only model see images by handing them to a
configured vision model. `/vision show` and `/vision model <provider/model>`
pick the model. Replaces `@getpipher/vision`

### search - web search via the Exa API

`web_search` queries Exa with your `EXA_API_KEY` and hands back numbered
sources the model can cite. Replaces pi-web-access and the original
Codex-backed search

## Adding a new extension

1. Write the backend in `src/foo.zig` and add it to `bins` in `build.zig`
2. Write `extensions/foo.ts` glue that bridges via `createBackend("pi-foo")`
3. Document it in `docs/architecture.md` and this README

## Prompts

### q - question only

`/q` expands into an instruction telling the model not to change anything,
then passes through whatever you type after it

## Skills

### repo-audit - whole-repo improvement audit

Scans the whole repo for over-engineering, dead code, duplication, and
other problems, then lists what to fix ranked by impact. Adapted from the
ponytail-audit skill of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
