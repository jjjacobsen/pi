# Architecture

All extensions run directly in the pi process as TypeScript modules under
`extensions/`. They use the pi extension API, Node.js APIs, native `fetch`, and
small local helpers. Extension state is either kept in the pi session or stored
under the agent directory when it must survive a restart

## Shared TypeScript code and tooling

`extensions/lib/terminal-process.ts` supports the full-screen terminal commands

- `capture` runs validation commands with `execFile` and a 16 KiB output buffer
- `runOnTerminal` opens `/dev/tty`, starts a child with that descriptor as
  stdin, stdout, and stderr, then closes the parent descriptor
- An abort sends `SIGTERM` to the child
- The result is `exited N` or `signal N`
- `registerTerminalCommand` validates the executable with `--version`, then
  provides the shared TUI validation, terminal handoff, restoration, and result
  notification used by `/lg` and `/nvim`

`extensions/lib/toolkit.ts` contains two groups of helpers

- `toolError` throws tool failures so pi marks them as failed tool calls
- The Codex helpers choose a subscription model, resolve credentials through
  pi, and read the account ID and email from the OAuth token

Core pi packages and TypeBox are declared as `peerDependencies`, so pi uses its
bundled copies at runtime, and pinned `devDependencies` provide matching local
types for development. `@types/node` is development-only. `tsconfig.json` uses
standard local `node_modules` resolution, keeping type checking portable across
machines

`strict: false` is explicit because the extension code is deliberately light
on annotations. `hk.pkl` runs `tsc --noEmit -p tsconfig.json`, and `mise.toml`
pins the TypeScript version. `mise x -- hk check --all` must stay green

# Prompt input extension (`extensions/prompt-input.ts`)

An `input` hook quotes the raw text after `/goal`, `/handoff`, `/implement`,
and `/q` as one argument before pi expands the template. This preserves
newlines, indentation, and quotes with the existing `$@` placeholders and
`/goal` default. Command source paths restrict this behavior to this package's
prompt files. Extension-injected messages and other commands are unchanged

# Bar cursor extension (`extensions/bar-cursor.ts`)

The extension replaces the main input editor with a minimal `CustomEditor`
subclass. Its renderer removes only the inverse-video sequence that pi uses for
the software block cursor and keeps the cursor marker at the same cell. It
enables pi's hardware cursor on each render so `/reload` cannot leave it hidden
when pi reapplies its settings. It embeds pi's working, compaction, summary, and
retry indicators in the editor border through `embedWorkingStatus`, and sends
the standard DECSCUSR steady-bar sequence to the terminal

On session shutdown, including `/reload`, it resets the terminal cursor shape
and restores pi's previous hardware-cursor setting. On quit it also shows the
terminal cursor, since interactive shutdown stops the TUI before extension
cleanup. Non-TUI modes do nothing

# Commit extension (`extensions/commit.ts`)

## Goal

`/commit` stages all changes, asks the selected model for a Conventional Commit
message, validates it, and creates the commit. It has no automatic trigger.
The model-callable `commit` tool and both slash commands call one shared
workflow. The tool accepts only an optional `intent` string with the same
`[CAS-1234] [intent]` syntax. It never pushes. Prompt guidelines require an
explicit user commit request, route natural-language commit requests to this
tool, and require a check of the all-changes staging scope without removing
blocking files to bypass the safeguard

`/commit-and-push` shares the same workflow and arguments, then runs plain
`git push` only after a successful commit. It adds a Push timing phase and
reports push errors without undoing the local commit.
It is inspired by tmonk/pi-committer

`/commit-model` and `/commit-thinking` use the shared worker settings helper
and save settings in `~/.pi/agent/commit-model.json` for all sessions. Selecting
a model starts with thinking off, adjusted to its supported levels. Without
saved settings, commit uses the session model with low thinking. Saved models
must be available or the command stops before staging. Both message attempts
use the same model and supported thinking level

## Flow and behavior

1. Resolve the repository root and stop if root-level `goal.md` or
   `handoff.md` exists
2. Run `git add -A` so the staged snapshot is the change set used for message
   generation and commit
3. Collect cached name status, stat, a rename-aware `-U3` diff, the current
   branch, and commit-related guidance from root `AGENTS.md` and `CLAUDE.md`.
   Commit history is not used
4. Ask an isolated in-memory agent session to write one message with the
   selected model and thinking level, no tools, and compaction disabled
5. Validate the message. On failure, append the exact problems and ask once
   more
6. Recheck that staged changes exist and that `git write-tree` still matches
   the tree used for analysis
7. Run `git commit -F -`, then report the short hash and header

The prompt can include `/commit` arguments as intent, capped at 2 KiB, and the
last 12 user or assistant session entries, capped at 4 KiB. The complete prompt
is capped at 24 KiB and reserves room for both forms of intent before it trims
the diff context. The diff remains the source of truth

A leading ticket ID in `/commit CAS-1234 [intent]` is a required exact prefix.
IDs match `[A-Z][A-Z0-9]*-\d+`. Validation enforces the prefix on both attempts,
ahead of the conventional type. Explicit prefixes take priority over repository
guidance. Without one, the model may add a ticket only when repository guidance
requires it and the branch or session clearly identifies the current ticket.
Repository guidance adds rules but cannot replace the conventional format

Guidance and branch context precede the diff so they survive context truncation.
The worker has no automatic instruction-file loading, including user-level
`AGENTS.md`. The root-file extractor includes lines containing `commit` and the
next two nonempty lines, not the complete instruction files

Small diffs up to 6 KiB are sent as-is. Larger diffs become a declaration-like
digest with at most 8 hunks and 14 selected lines per file. The digest is
capped at 12 KiB. Git stdout is normally capped at 32 MiB, stderr at 16 KiB,
and smaller metadata calls use lower caps. Commit guidance is capped at 2 KiB

The isolated session receives the complete selected model definition so custom
headers, compatibility settings, and sampling parameters stay intact

Validation requires an allowed Conventional Commit type, an optional valid
scope, a specific description, a header no longer than 100 bytes including any
ticket prefix, no raw diff
noise, and a substantive body of at least 50 bytes. Allowed types are `feat`,
`fix`, `docs`, `refactor`, `test`, `perf`, `ci`, `chore`, `build`, `style`, and
`revert`

Each git command and the commit child have a 60-second timeout. The command
context signal or tool execution signal cancels git processes, the commit
child, and the message-writing agent session. Commit stdout and stderr are
drained concurrently into bounded
buffers, so verbose hooks do not block the child or grow memory without a
limit. `/commit-timing [normal|verbose]` saves its view independently in
`~/.pi/agent/commit-timing.json` across sessions. Bare `/commit-timing` opens a
TUI selection, and `normal` is the default. Normal live progress shows Analyze,
Write message, and Create commit with elapsed time for the whole phase.
`verbose` retains timings for each Git step, context preparation, model session
setup, generation, validation, and retries. Both views summarize reached phases
or steps and the total, including on early return or failure. The Git commit
duration includes hooks and signing together. Headless sessions skip the widget
and notifications safely

The shared workflow uses `ExtensionContext`, with no command-only session
controls or blocking UI dialogs. The tool runs sequentially and returns the
short hash and header, or `nothing to commit`, as text. Workflow errors throw
so Pi marks the tool result as failed, rather than returning success after an
error notification. Slash commands still report errors through notifications

There is no fallback message and no confirmation prompt. A second invalid
message reports the validation problems and the last attempt. One invocation
creates one commit, and inferred intent can still be wrong

# Image generation extension (`extensions/imagegen.ts`)

`/image-model` lists Pi's available image catalog through
`modelRegistry.getAvailableOfType("image")`. It shares the searchable picker and
queued settings writes with subagent, browser, and commit through
`worker-model.ts` and `worker-picker.ts`. The shared helper can omit thinking
controls for image models. Settings contain only the exact `model` reference in
`<agent_dir>/image-model.json`, separate from the main coding model and shared
across sessions

The `imagegen` tool reads that choice for each call and resolves it against the
available image catalog. An unavailable model fails without switching providers
It sends text and local reference image blocks to
`ctx.modelRegistry.generateImages()`. References require image input support
Pi owns credentials and catalog updates. `extensions/lib/image-providers.ts`
lists native models, identifies file formats, and registers a small OpenRouter
image implementation through `pi.registerProvider()`. The registration keeps
Pi's built-in models, authentication, chat, and classifier implementations

All returned images are saved with their original bytes, correct format suffix,
and numbered names for additional images. Exclusive writes use Pi's file
mutation queue and never overwrite existing files. The first image gets a
preview capped at 1024 pixels per side and 1 MB. Native text blocks accompany
the paths. Native usage feeds tool usage and details, including returned errors
with usage. Native Chat Completions cost is a catalog-based estimate. The
image-only adapter uses OpenRouter's reported `usage.cost` when present

Pi 1.3.0 incorrectly sends image-only OpenRouter models to Chat Completions
The registered adapter uses `POST /images` for models without text output,
sending `prompt` and optional `input_references` and normalizing `data[].b64_json`
Models with text output delegate to Pi's built-in image implementation
The tool still calls `ctx.modelRegistry.generateImages()` for the exact saved
model. There is no endpoint retry or model substitution
The old Vercel adapter is removed. Providers need native image models and an
image implementation to appear here. `/image-thinking` is removed because the
native image API has no thinking control. Selecting a model writes only its
reference, without the old API mode or thinking metadata

Generation has a five-minute deadline, shares the agent abort signal, and sets
`maxRetries: 0` to prevent native request retries. Native error, aborted, and
empty-image responses return failed tool results. No dependencies are added
The pinned 0.99.1 development types omit `ModelRegistry.generateImages`, so a
type-only intersection uses the exported `ModelRuntime` method signature
Runtime support requires Pi 1.3.0. The explicit image-only provider adapter is
necessary until Pi supports OpenRouter's dedicated Images API

See [imagegen.md](imagegen.md) for the tool contract, billing details, and limits

# Lazygit extension (`extensions/lazygit.ts`)

## Goal

`/lg [path]` gives the full terminal to lazygit, then restores pi when lazygit
exits. It is available only in TUI mode

## Flow and terminal handling

The target is the optional path resolved against `ctx.cwd`, or `ctx.cwd` by
default. Before changing the screen, the extension runs `lazygit --version`
and `git -C <target> rev-parse --show-toplevel`. Missing lazygit, cancellation,
and non-repository targets are reported without a screen change

A custom TUI component obtains the live TUI handle. It calls `tui.stop()`,
uses the shared terminal helper to start lazygit in the target directory with
`/dev/tty` as all three standard streams, waits for exit, then always calls
`tui.start()` and requests a full redraw. The notification reports `exited N`
or the terminating signal. Exit 0 is informational and other exits are
warnings

The command signal sends `SIGTERM` to lazygit. There is no fixed run timeout.
While it runs, lazygit owns the terminal and handles its normal keys. Stopping
the TUI does not pause pi's agent loop

This design is Unix-only because it requires `/dev/tty`. A spawn failure after
validation causes one brief stop and redraw. If the pi process is killed in a
way that cannot run cleanup, lazygit can remain attached to the terminal

# Neovim extension (`extensions/nvim.ts`)

## Goal

`/nvim [path]` gives the full terminal to neovim and restores pi after `:q`.
It uses the same TUI and `/dev/tty` handoff as `/lg` and is available only in
TUI mode

## Flow and terminal handling

The target is resolved against `ctx.cwd`, with the current directory as the
default. `nvim --version` validates the executable before the TUI stops. No
repository check is needed

The extension stops the TUI, starts `nvim` in the target directory with
`/dev/tty` as stdin, stdout, and stderr, waits for it, and always starts and
fully redraws the TUI. The result reports the exit code or signal. The command
signal sends `SIGTERM` to neovim, and there is no fixed run timeout

The Unix-only, late-spawn blink, background agent-loop, and hard-process-death
limits are the same as lazygit

# Anki skill (`skills/anki/SKILL.md`)

## Goal and design

The `anki` skill turns short, context-dependent requests into source notes in
`~/Projects/memory`. It reads that repository's instructions and the selected
note type's field and card documentation before it writes anything

The skill selects the narrowest existing note type, uses `basic` for general
knowledge, and chooses a subject deck rather than a project-specific deck. It
checks for existing knowledge, writes one atomic pipe-delimited source line,
and stops. It never invokes the Anki import, preview, sync, or push workflow and
never commits the memory repository

# Browser extension (`extensions/browser.ts`)

## Worker

`browser({task})` runs a self-contained browser task in a fresh in-memory pi
`AgentSession` with only `bash`. The worker uses the plain agent-browser CLI
with its native configuration and environment. It receives the task literally,
without prompt-template expansion, and does not load extensions, skills,
prompt templates, themes, or context files. The caller must include URLs,
inputs, authorization, applicable user/project rules, and success conditions

`/browser-model` and `/browser-thinking` use the shared worker settings helper
and save selections in `~/.pi/agent/browser-model.json`. The model command
accepts an exact `provider/model`, and the thinking command accepts a supported
level. Both also offer pickers. A saved model is required. Thinking starts at
`off` and is adjusted to model support without changing the main session

Calls share a `ModelRuntime` for the model catalog and provider credentials,
but each worker has its own in-memory history and settings. Instructions direct
it to inspect the current page when continuing, use DOM, accessibility trees,
and text instead of screenshots or coordinate clicks, and leave the browser
open. Bash command starts produce progress updates. The main agent receives
only the final report, truncated with pi's standard tool-result limit, plus
model, thinking, and usage metadata. Failed and cancelled calls return
`isError: true` and retain available usage in pi's session totals

## Browser lifetime and dashboard

The browser starts lazily on the first CLI browser command. The extension adds
no per-session namespace, session, profile, configuration, or shell wrapper.
Native defaults use a temporary profile, not the daily browser. The default
browser is shared across pi sessions and stays open across calls and turns,
including worker failure or cancellation. Session changes, forks, reload, and
shutdown do not close it

`extensions/lib/browser-runtime.ts` runs the plain CLI for dashboard and close
commands. Native configuration and environment apply to all calls. To use system
Chromium, set `AGENT_BROWSER_EXECUTABLE_PATH` in mise. The extension does not
search PATH for Chromium

`/browser-dashboard` takes no arguments. It checks `session info --json` for an
active default shared browser before running `dashboard start --json` and opening
the local URL. If no browser is open, it reports that fact without starting one.
Keep the dashboard local, do not expose it to a network

`/browser-close` aborts and waits for only this extension's active worker, then
runs `agent-browser close --all`. Native close-all semantics apply, so browsers
used by other pi sessions can close too. The standalone dashboard stays running.
There is no pi session lifecycle cleanup

Browser setup is adapted from [Vercel's agent-browser skill](https://github.com/vercel-labs/agent-browser/tree/main/skill-data/core)

# Pi upgrade skill (`skills/pi-upgrade/SKILL.md`)

## Goal and design

The `pi-upgrade` skill treats the exact pi development dependency version as
the last reviewed release. It compares that version with `pi --version`, reads
every intervening release section from the installed changelog, follows
relevant documentation, and maps affected APIs back to this repository's
extensions and skills

The review covers extension lifecycle, TUI and editor behavior, tools,
providers, sessions, skills, settings, environment variables, and keybindings.
It reports relevant findings before editing, adapts code and documentation,
then updates `pi-ai`, `pi-coding-agent`, and `pi-tui` together to the installed
version with exact npm versions. It removes obsolete compatibility workarounds
and runs the full repository checks. It never updates the installed pi program,
downgrades dependencies, or commits

# Repo audit skill (`skills/repo-audit/SKILL.md`)

## Goal and design

The package exposes `repo-audit` through the `skills` entry in `package.json`.
It performs a whole-repository improvement audit and changes nothing

The skill is adapted from DietrichGebert's ponytail-audit. It keeps the ranked
one-line format, `cut`, `stdlib`, `native`, `yagni`, and `shrink` tags, and the
final `net:` estimate. It adds duplication, dependencies, errors, performance,
security, tests, architecture, and documentation

The model must first map the repository and read its conventions, then verify
each finding in the code and its uses. It skips generated and third-party
content, never flags deliberate project conventions, caps the report at 15
findings, and names a concrete replacement for every finding

# Peon extension (`extensions/peon.ts`)

## Goal

Peon plays Warcraft orc peon and human peasant lines for session start, task
acknowledgement, task completion, task error, and rapid prompt spam. `/peon`
opens a settings panel. The two packs are mixed for every category, and a pick
does not immediately repeat within that category. Task completion draws from all
33 unique voice lines, regardless of which other categories are enabled

The extension intentionally omits the other sound packs, pack installation,
relay mode, desktop notifications, preview sounds, and unsupported event
categories from pi-peon-ping

## Assets, config, and state

The 33 WAV files live in `assets/peon/` and are played directly with PipeWire's
`pw-play`. The sound packs are Orc Peon by tonyyont and Human Peasant by
thomasKn from OpenPeon CESP, licensed CC-BY-NC-4.0

Config is `<agent_dir>/peon.json`

- `volume`, set by the UI from 10% through 100%, with 50% as the default
- `paused`, false by default
- `silent_window_seconds`, 0 by default
- `annoyed_threshold`, 3 by default
- `annoyed_window_seconds`, 10 by default
- One enabled flag for each of the five categories

The settings panel changes pause state, volume, silent window, and category
flags. Config writes replace the file directly. Settings updates are serialized from
load through save so rapid changes cannot overwrite each other. A missing or
invalid config uses defaults and logs non-missing-file errors. Settings-save
failures are shown as UI errors

Cross-event state is `<agent_dir>/peon-state.json`

- Last sound index for each category
- A 16-entry ring of prompt timestamps
- Last agent start and last completion time

State loads before each event and is written through a temporary file after it.
The final rename is best-effort, matching the previous notification behavior.
Invalid state uses defaults and logs the problem. Other state-save failures are
logged but do not break the lifecycle event. A promise queue serializes events
so two state read and write cycles do not overlap. The active audio-player child
is kept only in process memory, so Peon never signals a PID restored from disk

## Event behavior

- `session_start` plays for every start reason, including reload
- `agent_start` records the start and prompt time, then plays rapid-spam audio
  when the configured number of prompts falls in the configured window.
  Otherwise it plays acknowledgement audio
- A failed tool execution plays task-error audio
- `agent_end` plays completion audio only when the last assistant stop reason
  is not `error`, at least 5 seconds passed since the previous eligible end,
  and the run met the silent-window duration. A run that is too short does not
  start the debounce window

Paused or disabled categories do not play. Before a new sound starts, the
extension sends `SIGTERM` to the recorded player PID. It starts `pw-play`,
passing the configured 0–1 volume to the player. The player is detached with
ignored standard streams, `unref` is called, and the new PID is recorded so
voice lines do not overlap. Unsupported platforms and
spawn failures log one line and do not break pi

Lifecycle sounds run only in sessions with a UI

# Status extension (`extensions/status.ts`)

## Goal and behavior

`/status` opens a TUI panel with current OpenAI Codex subscription and
OpenCode Go quota windows, plus the X balance in USD. The view is
adapted from can1357/oh-my-pi. It does not scan session use, store totals, or
write a cache

All providers are fetched in parallel with native `fetch` and independent
30-second timeout signals. Closing the panel aborts all requests

- OpenCode Go calls `GET https://opencode.ai/zen/go/v1/usage` with
  `Bearer $OPENCODE_API_KEY` and shows rolling, weekly, and monthly limits
- Codex calls `GET https://chatgpt.com/backend-api/wham/usage`. Credentials,
  OAuth refresh, and `auth.json` updates stay in pi's model registry. The
  request includes the bearer token and `ChatGPT-Account-Id` when available
- X calls [`GET https://api.x.com/2/usage/credits`](https://docs.x.com/x-api/usage/get-usage-credits)
  with `Bearer $X_BEARER_TOKEN`. `data.total_balance` is spendable USD, not cents

Missing credentials and request errors show for that provider only. Response
bodies are capped at 1 MiB before JSON parsing. The panel shows account information,
used bars, free percentages, reset times, status colors, extra Codex feature
limits, and saved reset credits. Balances show dollars to two decimal places
without percentage bars. `[r]` refreshes, `[q]` or Esc closes, duplicate
refreshes are ignored, and results that arrive after close are discarded

# Search extension (`extensions/search.ts`)

## Goal

`web_search` sends one query to Exa and returns a numbered source list. The
calling model writes the answer and cites entries with `[n]`. The API key is
read from `EXA_API_KEY` at call time. There is no config file or auth flow

## Request and result behavior

The extension sends `POST https://api.exa.ai/search` with `x-api-key`,
`type: "auto"`, and `contents: { highlights: true }`, as recommended in
[Exa's highlights guide](https://exa.ai/docs/search/highlights). Exa selects
query-relevant passages instead of returning the beginning of each page

`numResults` defaults to 8 and is capped at 10. `domainFilter` values become
allowed domains, or excluded domains when prefixed with `-`. Day, week,
month, and year recency values map to an ISO UTC `startPublishedDate`

Both modes make the same request. The extension joins each result's
`highlights` and caps the displayed excerpt at 900 bytes in `answer` mode or
250 bytes in `results` mode. This reduces downstream context and does not
select a lower Exa API price or latency tier. Publication dates are included
when available, normalized and capped at 64 bytes. Titles are normalized and
capped at 200 bytes. Results are deduplicated by URL and capped at 30 sources. The complete
formatted output is capped at 32 KiB. An empty result is the successful text
`No results found.`

The Exa response body is capped at 4 MiB. Error response text used for API
messages is capped at 8 KiB. A missing results array or invalid JSON fails the
tool. Exa's positive `costDollars.total` is returned as tool usage with zero
tokens, including when no sources are found, so the search cost appears in
session totals

## Timeout, retry, and cancellation

One 30-second timeout signal covers both attempts and the delay. The caller's
abort signal is combined with it, so cancellation stops fetch and retry sleep

HTTP 429, HTTP 5xx, and network `TypeError` failures retry once after 500 ms.
Other HTTP errors, including out-of-credit responses, fail immediately.
Redirects are not followed

A missing `EXA_API_KEY` produces a clear failed tool result. The public
parameter names remain `mode`, `numResults`, `recencyFilter`, and
`domainFilter`

# Footer extension (`extensions/footer.ts`)

## Goal

The custom footer replaces pi's built-in footer with two main lines and an
optional extension-status line

```text
π  ~/Projects/pi  main ↑1 ↓2 *1 ?2 +1
↑26 ↓44 CH95.0% $0.000 38,234/1.0M 12.4 tok/s   deepseek-v4-flash • max
```

It removes cache read/write totals and automatic-compaction segments, adds live
throughput, and uses the active theme. `CH` between output tokens and cost matches
pi's default footer: the latest assistant response's cache-read tokens divided
by input plus cache-read plus cache-write tokens, shown to one decimal place.
It is hidden until the session has cache usage and the latest response has prompt tokens

## Data and lifecycle

Session input, output, and cost totals include assistant messages, tool
results, compactions, branch summaries, and standalone usage entries such as
cache warming. The footer scans restored history
once, then adds usage only from new entries instead of rescanning on each
stream update. Context use comes from `ctx.getContextUsage()`. It shows
`?/window` immediately after compaction until
the next response provides verified use

Context color uses absolute thresholds of 100,000 tokens for warning and
200,000 for error. For smaller windows, 60% and 90% are fallback thresholds

Pi supplies the branch, provider count, and extension statuses. The extension
runs `git --no-optional-locks status --porcelain -b` when enabled, on branch
changes, and every 3 seconds. Only one status process runs at a time, and each
has a 2-second timeout. It reads the branch header to show commits ahead of the
upstream as `↑N` and commits behind it as `↓N`, matching the configured Starship
symbols. It then counts files with unstaged work as `*N`, untracked files as
`?N`, and staged files as `+N`. Both upstream counters are shown for a diverged
branch. The interval and branch listener are removed when the footer is disposed
or disabled

Throughput estimates one token per four streamed text or thinking characters.
Other assistant stream events do not add samples. It uses a rolling 15-second
sample window and excludes both time and character
growth across gaps longer than 2 seconds. It waits for 2 seconds of active data
before updating, starts at `0.0` for each session, updates during streaming,
and freezes the last value when idle. A short stream uses its overall average

The model and thinking level are right-aligned. The provider is shown when
more than one provider is available. Extension statuses use a third line

The footer starts automatically for TUI sessions. `/footer` switches between
it and the built-in footer. Message, model, thinking, session-info, compaction,
branch, git-status, and browser-status changes request a render

The footer scans agent-browser PID metadata immediately and every 10 seconds,
across the default socket root, any `AGENT_BROWSER_SOCKET_DIR`, and all their
namespaces. It detects live daemon records across pi sessions without launching
browsers or CLI processes. Dashboard PIDs and stale records are excluded. It does
not count tabs or Chromium child processes. Like native agent-browser discovery,
PID reuse can produce a false positive. Custom socket roots absent from the
environment cannot be discovered

When any daemon is live, a yellow web icon appears directly after git status,
with no count. No live daemon or a failed scan hides the icon, with no `?`
indicator. Only one scan runs at a time. The timer stops when the footer is
disposed or disabled

# Model settings extension (`extensions/model-settings.ts`)

`/model-settings` reads the subagent, browser, commit, and image settings through
`readWorkerModel` in `extensions/lib/worker-model.ts` on each invocation.
It also reads `SettingsManager.getGlobalSettings()` for the saved pi default
model and thinking level, excluding project and session overrides. Missing
global defaults show as `not set`. It shows a notification table without model
calls or configuration writes.
Unset subagent settings inherit the session values. Unset commit settings use
the session model and low thinking. Browser requires a saved model. The table
marks each value's source, unavailable models, and thinking clamped to model
support. Image settings check Pi's available image catalog and show that the
native image API has no thinking control.
It shows worker defaults, not subagent per-call overrides

# Subagent extension (`extensions/subagent.ts`)

## Goal

`subagent` runs a self-contained task in an isolated pi `AgentSession` and
returns only its final report. The parent context contains the task, returned
report, and usage instead of the full work transcript

## Session design

Each call creates one session in the current project directory. Sibling tool
calls can run concurrently with no shared session state. The subagent gets
`read`, `bash`, `edit`, and `write`, plus `web_search`. Each call creates a fresh
resource loader and extension runtime. `noExtensions: true` disables extension
discovery, and `additionalExtensionPaths` loads only the exact `search.ts` path.
Other extension factories do not run. The exact tool allowlist also prevents
recursive subagent calls. Skills and project instruction files still load.
Worker instructions append to the normal system prompt, preserving Pi's native
guidance and any configured `SYSTEM.md` or `APPEND_SYSTEM.md` behavior

Model and thinking resolve independently: per-call override, saved default,
then the caller's setting. `/subagent-model` and `/subagent-thinking` save
`model` and `thinking` in `<agent_dir>/subagent-model.json`, read on each call.
Select a model first. Its initial thinking level is `off`. Both commands share
`extensions/lib/worker-model.ts` and `worker-picker.ts` with browser, commit,
and image model selection, including filtering, validation, and queued
configuration writes. The shared code accepts a model catalog function and
omits thinking commands and settings for image models

A per-call model override must be an exact `provider/model` or an unambiguous
model ID. An explicit reasoning level must be supported by that model. Saved
or inherited thinking is clamped to the selected model. An unavailable saved
model fails the call rather than silently using the caller's model

Only the model catalog and authentication runtime are shared across calls.
Concurrent first calls share its initialization promise. Search registers no
providers or virtual models that could bind it to a worker session. Resource
loading and mutable extension state remain separate for each worker

Transcripts are stored at `<agent_dir>/subagents/<timestamp>_<id>.jsonl` and
link to the parent session when it has a session file. They can be inspected
or opened later with pi's session manager

The caller supplies a short `label` with the full `task`. Progress updates carry
the resolved model and thinking level, status, elapsed time, and latest tool
activity. A one-second timer updates elapsed time without streaming assistant
text or private reasoning. `extensions/lib/subagent-render.ts` renders a compact
header and metadata, with native expansion for the task, output, usage, and
transcript path. Final result details preserve metadata on session restore

Failed and cancelled calls return structured details with native `isError: true`,
which retains their metadata and usage without a separate event handler

The caller's abort signal calls `session.abort()` during execution. Cancellation
is checked again after session startup, before sending the prompt. A partial
transcript remains on disk after an active run is cancelled, and the tool reports
cancellation after the session stops. Timer cleanup, listener removal, and
session disposal use one cleanup path

The delegated task is sent literally without command, skill-command, or prompt
template expansion. The terminal assistant message must contain text. Error
and aborted stop reasons fail the tool with the model error and transcript
path. A length stop returns its partial report with an incomplete warning

The final assistant text is truncated with pi's standard tool-result limit.
When truncation occurs, the result includes counts and the transcript path.
Every result also includes the effective model, reasoning level, and
transcript path. Usage is summed from persisted assistant messages, tool
results, compactions, branch summaries, and standalone usage entries, including
cache warming. This retains usage from before compaction and includes search
charges in the parent totals

Concurrency is not limited in code. Provider rate limits are the practical
limit
