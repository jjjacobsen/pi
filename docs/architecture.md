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

An `input` hook quotes the raw text after `/fix-stack`, `/goal`, `/handoff`,
`/implement`, `/q`, and `/worktree` as one argument before pi expands the template. This preserves
newlines, indentation, and quotes with the existing `$@` placeholders and
`/goal` default. Command source paths restrict this behavior to this package's
prompt files. Extension-injected messages and other commands are unchanged

# Commit extension (`extensions/commit.ts`)

## Goal

`/commit` stages all changes, asks the selected model for a Conventional Commit
message, validates it, and creates the commit. It has no automatic trigger.
The model-callable `commit` tool and both slash commands call one shared
workflow. The tool accepts an optional `intent` string with the same
`[CAS-1234] [intent]` syntax and an optional `split` boolean, false by default
Both commands accept `[--split] [CAS-1234] [intent]`. The tool never pushes
Prompt guidelines require an
explicit user commit request, route natural-language commit requests to this
tool with `split: true` for logical multiple commits, and require a check of
the all-changes staging scope without removing
blocking files to bypass the safeguard

`/commit-and-push` shares the same workflow and arguments, then runs plain
`git push` only after the complete commit sequence succeeds. It adds a Push
timing phase and reports push errors without undoing local commits.
It is inspired by tmonk/pi-committer

`/commit-model` and `/commit-thinking` use the shared worker settings helper
and save settings in `~/.pi/agent/commit-model.json` for all sessions. Selecting
a model starts with thinking off, adjusted to its supported levels. Without
saved settings, commit uses the session model with low thinking. Saved models
must be available or the command stops before staging. Both message attempts
use the same model and supported thinking level

## Flow and behavior

The default workflow still stages everything and creates one commit

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

### Split mode

`--split` or tool `split: true` first runs the same all-changes analysis
Staged and unstaged changes, deletions, renames, and untracked files are included
The planner uses the same selected model and thinking level in a no-tool session
with a separate planning system prompt. It gets the complete available diff
and context, not the message digest, plus user intent, ticket prefix, and session
context. Git output limits still apply. Model context-limit failures stop the
sequence rather than silently omit files or diff content

A NUL-delimited cached name-status list supplies numbered whole-file units
Rename source and destination paths form one unit. The model returns an ordered
JSON array of group intents and unit IDs. Validation requires nonempty groups
with intent strings, known integer IDs, and exact coverage without duplicates
One group is valid. The staged tree and working files are checked after planning

`git read-tree` resets only the index to the starting HEAD, or an empty index
for an unborn branch. Working files stay in place. Each group is then staged
with literal path arguments, analyzed without `git add -A`, and passed through
the same message generation, retry, validation, tree check, hooks, and signing
The original user intent and exact ticket prefix apply to every message
Original staged versus unstaged selections are not preserved. Files are never
split into hunks

After each commit, the committed paths must match its planned group. Hooks may
format and restage those files. Remaining status must contain only unstaged or
untracked work in later groups. An altered commit scope, staged leftovers,
changes outside later groups, or any other failure stops the sequence
Hooks that require all changes together can require a single group

Failures report actual commits since the starting HEAD, unattempted groups,
and current Git status, even after cancellation. No commits, files, or index
changes are rolled back. A commit made before a hook-scope check fails is kept
No push starts until all groups and remaining-work checks succeed

The message prompt can include `/commit` arguments as intent, capped at 2 KiB, and the
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
short hashes and headers, or `nothing to commit`, as text. Workflow errors throw
so Pi marks the tool result as failed, rather than returning success after an
error notification. Slash commands still report errors through notifications

There is no fallback message and no confirmation prompt. A second invalid
message reports the validation problems and the last attempt. Without split
mode, one invocation creates one commit. Logical grouping and inferred intent
can still be wrong

# Image generation extension (`extensions/imagegen.ts`)

`/image-model` lists Pi's available image catalog through
`modelRegistry.getAvailableOfType("image")`. It shares the searchable picker and
queued settings writes with subagent, browser, device, and commit through
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
image-only adapter uses OpenRouter's reported `usage.cost` when present and
marks that total with `cost.totalFromProvider: true`

Pi 1.5.0 still incorrectly sends image-only OpenRouter models to Chat Completions
The registered adapter uses `POST /images` for models without text output,
sending `prompt` and optional `input_references` and normalizing `data[].b64_json`
It applies Pi's client identity headers before model and request header overrides,
including explicit `null` removals
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
Runtime support requires Pi 1.4.0 for the client identity API. The tool uses
`ModelRegistry.generateImages` directly. The explicit image-only provider
adapter is necessary until Pi supports OpenRouter's dedicated Images API

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
`AgentSession` with `bash` and the internal `screenshot_artifact` tool. The worker uses the plain agent-browser CLI
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
it to inspect the current page when continuing, prefer DOM, accessibility trees,
text, and semantic refs, use screenshots for authorized visual checks or evidence,
and run `agent-browser close`
when the delegated task is complete unless the user asks to keep it open. The
worker leaves it open while waiting for user input, an answer to a question,
login, or another manual browser action. Returning a report is not itself task
completion. Reports include whether the browser was closed or left open and
what is needed to continue a paused task. Bash command starts produce progress
updates. The main agent receives a PASS, FAIL, or BLOCKED report with observed
evidence, truncated with pi's standard tool-result limit, plus published screenshot
paths, a reduced preview of the first image, and model, thinking, and usage metadata. Failed and cancelled calls return
`isError: true` and retain available usage in pi's session totals

## Browser lifetime and dashboard

The browser starts lazily on the first CLI browser command. The extension adds
no per-session namespace, session, profile, configuration, or shell wrapper.
Native defaults use a temporary profile, not the daily browser. The default
browser is shared across pi sessions. Worker instructions close only the current
browser session after task completion, not all sessions. Paused tasks keep their
browser state across calls and turns. There is no unconditional cleanup after a
worker report, failure, or cancellation. Session changes, forks, reload, and
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

# Device extension (`extensions/device.ts`)

`device({target, task})` is a separate, minimal worker using Callstack's
[agent-device CLI](https://github.com/callstack/agent-device). `target` must be an
explicit dedicated Android emulator ADB serial matching `emulator-[0-9]+`
Physical devices and other platforms are not supported. `task` carries the exact
app package, inputs, authorization, applicable rules, and expected results

`/device-model` and `/device-thinking` use the existing worker settings helper
and save to `<agent_dir>/device-model.json`. A saved model is required. Thinking
starts at off and is clamped to model support. The main and browser models do
not change. `/model-settings` includes the device worker

Each call has its own in-memory AgentSession, settings, and resource loader
Only the model/authentication runtime is reused. Discovery of extensions,
skills, templates, themes, and context files is disabled, so the caller must
supply all applicable rules. The tools are `bash` and `screenshot_artifact`
The task is passed literally without template expansion. One call runs at a
time per extension instance. Cancellation aborts the worker and disposes only
the Pi session, with no device cleanup

Instructions require explicit platform and serial selectors on every device
command, inspect existing CLI session state, and preserve current app state
An existing matching session is inspected without reopening. A new session
uses `open --foreground --no-test-ime` without relaunching the app. The bundled
snapshot helper APK may be installed automatically only on the named emulator
This is not approval for other installs. The worker does not boot devices,
close sessions, force-stop apps, or shut down emulators as cleanup. Flutter apps
and their development connections stay running. These are worker instructions,
not an OS sandbox around the bash tool

Progress shows command starts, not private reasoning. The final report is
PASS, FAIL, or BLOCKED with observed vs expected results, target/package,
artifact paths, blockers, and current app state. Reports use Pi's normal text
truncation limit. Failed or cancelled calls retain usage and published evidence
Usage is summed from session entries by `lib/worker-usage.ts`, also used by
browser, including compaction and cache warming. Worker and subagent sums mark
`cost.totalFromProvider` true only when every included usage explicitly does

## Screenshot evidence for browser and device

`lib/screenshot-artifacts.ts` provides the internal `screenshot_artifact` tool
Each worker captures with its own CLI to a unique path, then explicitly
publishes that existing file. The helper reads the file, detects its image
format with the existing image helper, and records its absolute path. It does
not capture, write, delete, or alter images

The first published image gets a native Pi preview through `resizeImage`,
capped at 1024 pixels per side and 1 MB. Original files remain unchanged
Paths and that one preview reach both the worker and caller as native tool
content, including after worker errors. Details retain the paths. Other images
are path-only. Pi's normal image settings and terminal image support apply
Capture must follow supplied task rules. Evidence can contain private app/page
data and is sent to both model providers. A screenshot alone does not verify
behavior, so reports must name the observed result and limits

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
`pw-play` on Linux or `afplay` on macOS. The sound packs are Orc Peon by
tonyyont and Human Peasant by thomasKn from OpenPeon CESP, licensed CC-BY-NC-4.0

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
extension sends `SIGTERM` to the recorded player PID. It starts `pw-play` on
Linux or `afplay` on macOS, passing the configured 0–1 volume to the player.
The player is detached with ignored standard streams, `unref` is called, and
the new PID is recorded so
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

# Remote extension (`extensions/remote.ts`)

`/remote` starts one Node HTTP(S) listener inside the existing Pi process, only
on the connected Tailscale IPv4 address returned by `tailscale status --json`.
Port zero selects an available port. Nothing starts in the extension factory
The command shows the current link and QR code if already running. A
`globalThis` slot keyed by `Symbol.for("jonah.pi.remote")` holds the process-owned
listener, connection set, startup controller, link, page renderer, and current API handler
The transport callbacks live outside the extension factory and capture no SDK
context. `session_shutdown` detaches the session-bound handler and QR widget. For new,
resume, fork, clone, and reload, the listener and its credentials stay alive,
with a transition state until `session_start` binds a fresh handler and resets
live-message, compaction, and dialog state. Old SDK contexts are not used after replacement. This also follows changes initiated
in the terminal. The extension must load in each replacement runtime, including
when the working directory changes. Loading it globally meets that requirement
Each page request calls the current renderer with the listener's original CSP
nonce. `session_start` binds the newly loaded `remotePage` implementation, so
browser refresh after reload gets the updated UI without changing the listener,
link, or credentials. The previous pure renderer stays available during the
transition and retains no SDK context

`/remote off` and shutdown with reason `quit` abort startup, close the listener
and all connections, and invalidate the in-memory credentials. Raw sockets are
tracked so shutdown also closes connections still in the TLS handshake. Actual
process exit also removes the listener and its memory. No system service or
additional session-data files are created

If the node's DNS name is in Tailscale's enabled certificate domains, the
extension runs `tailscale cert --cert-file - --key-file - <domain>` and loads
the certificate and key directly from captured stdout. It binds HTTPS to the
Tailscale IP, with the DNS name in the link. It does not change tailnet settings,
Serve, or Funnel. The daemon owns its normal certificate cache. If HTTPS is
not enabled, it explicitly reports HTTP over encrypted tailnet transport.
Certificate errors stop startup rather than downgrade an HTTPS-capable node
Certificates are obtained on each start, not renewed within a running listener

The terminal link and QR code contain a 256-bit random bearer token in the URL
fragment. Local `qrencode -t UTF8i -m 4` receives the URL on stdin, not in process
arguments, and returns half-block text captured only in memory. Every QR row
sets truecolor black foreground and opaque white background with a four-module
quiet zone, independent of terminal themes. A non-blocking Pi widget above the
editor shows the code without wrapping or cropping and leaves input focus alone
If it cannot fit with room for the editor, it asks for a larger terminal and
keeps the text link. `/remote hide`, successful browser authentication, and
authenticated state polling clear the widget and cancel pending QR generation
QR command failure warns and leaves the text link and listener usable. The
extension writes neither QR data nor the URL to session entries or extra logs
The page removes the fragment, exchanges it through `POST /auth`, and keeps
an independent random bearer credential in same-tab `sessionStorage` for refresh
API calls send it in the Authorization header, not a cookie. A new fragment
clears the old credential before authentication, with no fallback if it fails
A 401 clears the stored credential. There is no `localStorage` use. Credentials
last only until stop. No token is sent in request URLs or added to Pi history
Possession of the link plus network access grants the same agent control as
terminal prompts, not a restricted or read-only role

Every request must match the exact Host and any supplied Origin. POST requires
the exact Origin. API requests reject cross-site fetch metadata. Authenticated
API calls require a bearer header, with no cookies or CORS support. The static page
has no external resources, uses nonce-based CSP, cannot be framed, disables
caching and referrers, and renders conversation data only with `textContent`.
Text-only and command JSON bodies are limited to 64 KiB. Image prompt JSON
bodies are limited to 70 MiB, with up to five images at 10 MiB each, and decoded
text to 64 KiB UTF-8. Non-voice request uploads have a per-request 60-second deadline
Authenticated voice uploads are exempt. Node's shared requestTimeout is disabled
because it cannot exempt one request. Header timeout stays at 10 seconds
CSP permits only blob URLs for images, for the local pending-image preview
The extension adds no general file-serving, tool-execution, or shell endpoint

`extensions/lib/remote-page.ts` provides the mobile page. It polls `/state` at
700 ms with version and leaf markers. The leaf marker includes the session ID
so two empty sessions cannot share a marker. Unchanged state returns 204, and
history is sent only when the marker changes. Raw `getBranch()` entries supply the active
branch history, including old messages and markers after compaction. It does
not use the compacted model projection or include abandoned branches, system
prompts, thinking blocks, or image bytes. Message events retain the current
assistant snapshot for live text. Compaction events update status without
closing the listener. Tree navigation refreshes history on the next poll

Tool-result and terminal-command history views carry `collapsible: true` and
an `id` from the session entry, with `toolCallId` as the tool-result fallback
The browser uses this flag, not role text or a tool-name list, to render native
`details`/`summary` rows. The summary keeps the tool name and error or cancellation
label visible. Output still uses `textContent` with no additional truncation
Assistant text and tool-call markers remain ordinary visible messages
An in-memory set of open result IDs preserves expansion across history rebuilds
and tree navigation. Rebuilds also restore summary keyboard focus. The set resets
when the session ID changes or the page refreshes, not on reload or a temporary
network disconnect. New results start collapsed

Each authenticated `/state` request also reads the footer extension through
`lib/footer-state.ts`. A synchronous event-bus request returns only formatted
path, branch, Git counters, context usage and color, model ID, provider label,
and reasoning label, or null when the footer is absent or disabled. The same
footer function supplies both displays, including provider visibility and
`thinking off` for reasoning models with thinking disabled
There is no separate Git poll, context calculation, or model lookup in remote. The serialized
footer is part of the version marker, so footer-only changes cannot return 204
The page renders the data with `textContent` in a compact strip above the
composer. Reload transition responses retain the last plain footer snapshot
Other transitions and connection failures hide the strip. Status-only polls do
not scroll the conversation

The header's Changes button opens a full-screen, read-only dialog without
replacing the chat. Close restores the saved chat scroll position, and polling
does not scroll the chat while the dialog is open. Refresh reads a new snapshot
`GET /changes?workspace=<id>` returns the current repository's changed files,
status codes, and combined added/deleted counts against HEAD. An optional
`path` and `view=diff|source` returns one listed file's unified diff or current
full source. The page uses text-only DOM nodes, line numbers, red/green diff
rows, and horizontal scrolling, with a bounded file list above the diff on phones
There are no Git write operations, editor, history, tree, or syntax highlighter

`lib/remote-changes.ts` uses bounded Git argv calls with literal pathspecs,
no optional locks, no external diff or textconv, and no rename detection
Renames appear as deletion/addition pairs. Untracked files exclude ignored
files and appear as additions. Without HEAD, current files are additions
Source reads require membership in a fresh Git status list, a regular file,
and a canonical path inside the current repository with no symbolic links
Deleted source and binary or oversized content return clear messages
Limits are 300 changed files, 256 KiB and 5,000 lines per content view,
1 MiB of Git metadata output, and three seconds per Git command
Binary or unavailable new files are excluded from line counts and reported
No files, index entries, or Git objects are written

Each session runtime gets a random workspace marker included in the state
version and Changes requests. A mismatched marker rejects the request, and
handler identity is checked after asynchronous reads. The page clears Changes
on workspace changes or connection loss and discards superseded responses
Refresh cannot reuse data from an old repository after session replacement
The existing process-owned listener and authentication are unchanged

`POST /prompt` accepts JSON `{ text, images?: [{ data, mimeType }] }`, with up to
five base64 PNG, JPEG, or WebP images. Image-only prompts use empty text
The server validates the array and count, each image's base64, source size and
format, selected model image input support, and `images.blockImages`
It calls public `resizeImage` for each image with the selected model's
`inputLimits.images.resize`, or Pi's default limits
This runs even with automatic resizing disabled because queued follow-ups can
skip Pi's prompt resize path. Decode or resize failures reject the request
Session replacement, compaction, and model changes during resize require retry

The endpoint rejects leading slash commands and submits literal text or native
text/image blocks through `pi.sendUserMessage` with `deliverAs: "followUp"` and
expansion disabled. `/command` also rejects attachments, never discards them
Pi's normal input hooks still apply. During compaction, prompts receive an
explicit retry message. `POST /stop` requests `ctx.abort()`

The composer uses a native file picker with multiple selection and no forced
camera capture, and intercepts paste only when the clipboard exposes images
Both paths add to one pending list with the same native browser image preparation
A batch that would exceed five images is rejected in full with a clear error
Valid images up to 10 MiB keep their original bytes. Larger originals are drawn to canvas with a maximum edge of
2560 pixels, then 1920 or 1440 if needed to fit 10 MiB, without enlargement
PNG stays lossless, JPEG and WebP use quality 0.9, and PNG/WebP retain transparency
The server still validates and resizes uploads. Send is blocked during preparation
or after a preparation error. Failed preparation keeps the selected file visible
for removal. Each pending image has its own preparation state, blob URL preview,
and Remove button. Removed images cannot return when preparation completes
Removing, successfully submitting, or leaving the page revokes the image's URL
Failed sends retain attachments. Success removes only the submitted images,
preserving additions during sending and any changed message. Image uploads get
a 60-second browser deadline, ordinary requests 15 seconds. No upload retry is automatic. Pending
images are not stored across page exits. History still uses `[Image omitted]`

`POST /transcribe?workspace=<id>` accepts authenticated WebM or MP4 audio,
never a prompt. `lib/remote-voice.ts` reads the version-1 Pi Voice settings at
`<agent_dir>/pi-voice.json` and dynamically imports the public
`node_modules/transcribe-cpp/dist/index.js` entry from the installed Pi Voice Git
package at `<agent_dir>/git/github.com/earendil-works/pi-voice`
Pi's `getAgentDir()` supplies the agent directory and honors `PI_CODING_AGENT_DIR`
It does not import Pi Voice source or share its
model. The configured backend must be transcribe-cpp. Model path and language
are read on each request, with `auto` mapped to library language detection
The public `TranscribeModel.load`, `model.transcribe` with `timestamps: none`
and an abort signal, and `model.dispose` handle inference without downloads

One process-owned voice slot holds only an abort controller and completion
promise. Concurrent requests are refused, not queued. Shutdown, reload,
session replacement, remote off, and client disconnect abort the request
Shutdown waits for cleanup, so replacement cannot start another model load. Native load has no cancellation parameter, so it must finish
before disposal. Native inference cancellation is cooperative
Uploads stream to a private temporary file with backpressure, without a size or
upload deadline. Spawned `ffmpeg` from PATH, or `PI_VOICE_FFMPEG_PATH` when set,
decodes the full recording to a temporary mono 16 kHz f32le file, without a
duration cap, process deadline, or exec output buffer. It retains file/pipe protocols only and no shell. Cancellation kills
FFmpeg and waits for close before cleanup. Both files are removed in `finally`
The decoded file streams into one full Float32Array, without readFile's fixed
per-file ceiling or a second full PCM copy
The model is disposed after every transcription, including errors and aborts
There is no imposed voice processing deadline. Browser recording memory, host
disk and RAM, runtime buffer limits, and the selected model remain practical limits
The configured Parakeet Unified model reports maxAudioMs and effectiveMaxAudioMs
as zero, meaning no model audio-length cap. Its offline call uses full attention
in one pass, not an automatic long-form chunker, so compute memory grows with audio
Other models can reject long input or report output truncation

The HTTPS page detects MediaRecorder WebM/Opus or MP4 support and requests the
phone microphone only when the rightmost microphone button is pressed
The same button becomes a stop square and uploads once when pressed. Cancel voice
during recording clears local chunks without upload or inference. There is no
recording duration or byte cap, auto-stop timer, or transcription fetch deadline
Recording chunks stay in browser memory until Stop recording or cancellation
All finish, cancel, error, and pagehide paths stop microphone tracks, including
late permission grants
During voice input, the button row shows a cancel X on the left, compact status,
and the stop square on the right, with the normal Send/Stop Pi action hidden
The square is disabled while permission or transcription is pending
Cancel also aborts a pending upload or inference request
The returned transcript is appended to the latest textarea text with a separator,
without submission, input events, or automatic command menus
Workspace markers and handler identity reject stale work. Browser workspace
changes and disconnects cancel voice, so an old response cannot alter a new
session's composer. No audio is persisted in browser storage or Pi sessions

The action button after `/` sends while idle and requests `/stop` during Working,
Compacting, or Waiting for a terminal dialog. Stop ignores draft validation and
submission state, leaves text and images unchanged, and never submits the form
The action is disabled while disconnected or changing sessions. Explicit form
submission still supports queued follow-ups. Abort does not promise to close dialogs

Only the adjacent `/` button opens the command menu. Each choice calls
`submitCommand(value)` directly, without writing or resizing the textarea,
consuming draft images, or focusing a text field. Typed commands remain manually
sendable with arguments. Their text clears only after successful completion
`GET /commands` returns an explicit allowlist: new, resume, reload, compact,
commit, commit-and-push, and status. The last three appear only when their
extension answers the synchronous `lib/remote-command.ts` event-bus request
No skills, templates, source paths, or system-prompt data are exposed
`GET /sessions` uses `SessionManager.list()` for the current working directory and active storage directory. It returns IDs,
display names, modification times, message counts, and the current-session flag
The browser uses these entries in a searchable resume picker, opened by choosing
Resume or sending `/resume`. Search is not focused automatically, and choosing a
session submits immediately without opening the keyboard

`POST /command` accepts only listed command names while Pi is idle and not
waiting on a dialog or another remote command. A one-use in-memory request ID
routes through `/remote run <id>` via `pi.sendUserMessage` with expansion enabled
This obtains a supported `ExtensionCommandContext`, rather than pretending
that prompt text can execute terminal built-ins. The handler calls
`ctx.newSession()`, `ctx.reload()`, or `ctx.switchSession()` for the three
built-ins. Resume resolves a listed session ID to its path on the server
Compact uses `ctx.compact()` with optional instructions and completion/error
callbacks. Commit and status execute their loaded remote adapters,
not slash-message fallbacks. Adapters bind at session start and unsubscribe at
shutdown. They share the existing commit workflow and provider fetch/format helpers
The footer toggle remains terminal-only. Terminal command behavior is unchanged. Status returns a
single text snapshot with per-provider failures instead of opening a TUI panel
No unsupported command is sent to the model. Request bodies that span session
replacement are rejected instead of using stale SDK objects

`POST /command` returns 202 with an action ID before execution completes
`/state` carries the latest action's phase, running/done/error state, and result
A numeric revision keeps large output out of the request URL. Only the latest
result is retained in process memory, with text capped at 65,536 characters
Finished results clear after a valid remote prompt is submitted, including queued
or image-only prompts, or when a user message starts from any input source
Clearing advances the action revision. Running actions are not cleared
Prompt clearing does not run for slash-command dispatch or runtime lifecycle events
No command result is appended to a session or model conversation
The browser uses a compact expandable row and shows error notifications only
Action IDs reject late progress and completion from an older action. Model or
unrelated runtime changes interrupt running actions. Requested new/resume/reload
actions finish from the matching replacement lifecycle event, not dispatch
Model selections during their replacement startup do not interrupt these actions
Stop settles the compact command wait even if an extension delays SDK cancellation
Only plain action data and the reload footer snapshot survive replacement

The page reports terminal UI waits but does not implement dialogs. Prompt
submission acknowledges dispatch, not model completion
Remote command completion and failures are reported through state polling
Polling retries network failures automatically with the same credential and
resets transition status from fresh state. Authentication failure clears the
credential and requires the private link again. Recovery never resends prompts
or commands. A timed-out command can still finish. Tab closure or mobile OS
eviction can require the private link again. Phone sleep does not stop Pi

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
tokens and `cost.totalFromProvider: true`, including when no sources are found,
so the search cost appears in session totals

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
more than one provider is available. These display strings also supply the
remote strip's model row, which shortens long model labels and keeps reasoning
visible. Non-reasoning models have no reasoning label
Extension statuses use a third line

The footer starts automatically for TUI sessions. `/footer` switches between
it and the built-in footer and toggles the remote browser strip. Only the
boolean preference survives runtime replacements in a process-owned slot
The event-bus reader is bound at session start and removed at shutdown, with
no SDK objects stored in process state. It reads current SDK context usage and
the existing Git poll result through the same formatter as the terminal
Disposal clears the reader, removes listeners and timers, and aborts pending
Git work. Completed browser scans cannot update disposed state
Message, model, thinking, session-info, compaction, branch, git-status, and
browser-status changes request a render

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

`/model-settings` reads the subagent, browser, device, commit, and image settings through
`readWorkerModel` in `extensions/lib/worker-model.ts` on each invocation.
It also reads `SettingsManager.getGlobalSettings()` for the saved pi default
model and thinking level, excluding project and session overrides. Missing
global defaults show as `not set`. It shows a notification table without model
calls or configuration writes.
Unset subagent settings inherit the session values. Unset commit settings use
the session model and low thinking. Browser and device require a saved model. The table
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
`extensions/lib/worker-model.ts` and `worker-picker.ts` with browser, device,
commit, and image model selection, including filtering, validation, and queued
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
