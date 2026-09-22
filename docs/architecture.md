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

# Bar cursor extension (`extensions/bar-cursor.ts`)

The extension replaces the main input editor with a minimal `CustomEditor`
subclass. Its renderer removes only the inverse-video sequence that pi uses for
the software block cursor and keeps the cursor marker at the same cell. It
enables pi's hardware cursor, embeds pi's working, compaction, summary, and
retry indicators in the editor border through `embedWorkingStatus`, and sends
the standard DECSCUSR steady-bar sequence to the terminal

On session shutdown, including `/reload`, it resets the terminal cursor shape
and restores pi's previous hardware-cursor setting. Non-TUI modes do nothing

# Commit extension (`extensions/commit.ts`)

## Goal

`/commit` stages all changes, asks the current model for a Conventional Commit
message, validates it, and creates the commit. It has no config file or
automatic trigger. It is inspired by tmonk/pi-committer

## Flow and behavior

1. Resolve the repository root and stop if root-level `goal.md` or
   `handoff.md` exists
2. Run `git add -A` so the staged snapshot is the change set used for message
   generation and commit
3. Collect cached name status, stat, a rename-aware `-U3` diff, the last 25
   commit subjects, and commit-related guidance from root `AGENTS.md` or
   `CLAUDE.md`
4. Ask an isolated in-memory agent session to write one message with the
   current model, low thinking, no tools, and compaction disabled
5. Validate the message. On failure, append the exact problems and ask once
   more
6. Recheck that staged changes exist and that `git write-tree` still matches
   the tree used for analysis
7. Run `git commit -F -`, then report the short hash and header

The prompt can include `/commit` arguments as intent, capped at 2 KiB, and the
last 12 user or assistant session entries, capped at 4 KiB. The complete prompt
is capped at 24 KiB and reserves room for both forms of intent before it trims
the diff context. The diff remains the source of truth

Small diffs up to 6 KiB are sent as-is. Larger diffs become a declaration-like
digest with at most 8 hunks and 14 selected lines per file. The digest is
capped at 12 KiB. Git stdout is normally capped at 32 MiB, stderr at 16 KiB,
and smaller metadata calls use lower caps. Commit guidance is capped at 2 KiB

The isolated session receives the complete active model definition so custom
headers, compatibility settings, and sampling parameters stay intact

Validation requires an allowed Conventional Commit type, an optional valid
scope, a specific description, a header no longer than 100 bytes, no raw diff
noise, and a substantive body of at least 50 bytes. Allowed types are `feat`,
`fix`, `docs`, `refactor`, `test`, `perf`, `ci`, `chore`, `build`, `style`, and
`revert`

Each git command and the commit child have a 60-second timeout. The command
signal cancels git processes, the commit child, and the message-writing agent
session. Commit stdout and stderr are drained concurrently into bounded
buffers, so verbose hooks do not block the child or grow memory without a
limit. A TUI widget shows analysis, writing, and commit progress. Headless
sessions skip the widget and notifications safely

There is no fallback message and no confirmation prompt. A second invalid
message reports the validation problems and the last attempt. One invocation
creates one commit, and inferred intent can still be wrong

# Image generation extension (`extensions/imagegen.ts`)

`/image-model` discovers image-output models from configured OpenRouter and
Vercel AI Gateway providers and opens a searchable pi `Input` / `SelectList`
picker. The choice is stored in `<agent_dir>/imagegen.json`, separate from the
main coding model and shared across sessions

The `imagegen` tool reads that choice for each call, sends the prompt and any
local reference images, saves original image files without overwriting existing
files, and returns a resized preview of the first image. Writes use pi's file
mutation queue. Provider-reported cost is included in tool usage when available

`extensions/lib/image-providers.ts` owns discovery and provider-specific HTTP
requests. It resolves credentials and base URLs through pi's model registry.
Image models are not registered as coding models. OpenRouter uses its dedicated
Images API. Vercel uses Images endpoints for image-only models and Chat
Completions for multimodal language models

Discovery is on demand, with a 30-second network deadline per provider and
visible partial failures. Generation has a five-minute deadline, shares the
agent abort signal, and never retries automatically. No dependencies are added

See [imagegen.md](imagegen.md) for the tool contract, endpoint references,
billing details, and provider limits

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

## Goal and operation

The `browser` tool delegates a self-contained website task to a separately
selected model without changing the main session model. `/browser-model` uses
pi's configured model catalog and saves an exact provider/model reference in
`~/.pi/agent/browser-model.json`. Its picker supports fuzzy filtering, scrolling,
and terminal resizing. The command also accepts an exact reference as an
argument. `/browser-thinking` uses the same picker for supported thinking levels,
or accepts a level directly. Both selections persist independently of the main
session. Model changes clamp the saved thinking level to the model's support.
Without a saved thinking selection, the lowest supported level is used

Requests use the extension context's model registry, including its provider
authentication and the selected thinking level. Each worker supplies its tool-call
ID as `sessionId`, which lets the provider attach required session headers,
including OpenCode Go's `x-opencode-session`

The worker has an isolated in-memory conversation, a bounded DOM action tool,
and a structured finish report. When native page tools are discovered, it also
gets WebMCP inspection and invocation tools. It has no coding tools, shell,
eval, screenshots, or coordinates. Code validates each tool
call and maps it to positional CLI arguments through `extensions/lib/browser.sh`.
Only HTTP(S) navigation, snapshot/read, ref-based interactions, limited keyboard
keys, scrolling, and text waits are available. Navigation and page-changing
actions return the current URL and a fresh full snapshot with link destinations.
The host sends an action and its snapshot through one CLI `batch --bail` call,
using JSON stdin to preserve exact argument strings, including empty values.
The snapshot's `origin` supplies the full current URL, avoiding `get url` calls.
JSON is parsed before limiting model-visible output to 12 KB or 200 lines.
Model-visible observations focus on relevant controls and evidence while the
host keeps the full tree for target checks

Batch errors stop the task. Earlier actions may have run and are not rolled
back. The CLI can retry transport failures, so batch does not guarantee
exactly-once execution. Do not blindly repeat uncertain actions

The helper must return exactly one valid tool call. A response with the wrong
call count or invalid arguments gets one repair before execution only. This never retries an
executed action. The default limit is 20 decision
steps, configurable up to 40 per task. A five-minute work deadline and 45-second
CLI timeouts bound execution. An independent cleanup attempt closes the default
headless browser after completion, failure, or cancellation. Cleanup failures are reported, not
hidden. A shared process-local busy flag rejects overlapping
worker, direct-control, and command calls. This is not a cross-process lock.
Browser tasks remain serial

An explicit `visible: true` request uses headed Chromium and leaves the browser
open, including after failure, for user viewing or login. `reuseSession: true`
requires an owned visible session with no login pause or uncertain effects.
Use confirmed resume after a login or uncertain outcome before reuse. Foreign
sessions are never adopted. Default calls reject existing sessions and close
their own browser. At exit, a visible worker session passes to direct control,
paused for `needs_login` or marked uncertain for `failed` and `cancelled`

The worker returns `complete`, `blocked`, `needs_login`, or `needs_approval`.
Execution failures return explicit `failed` or `cancelled` reports with any
recorded usage. The outer tool successfully reports these outcomes, so callers
must inspect the status rather than assume tool completion means task success.
Completion and approval classification are model judgments, not a security
boundary or independent verification. Instructions require stopping before
consequential final actions and treating page content as untrusted

For login, use `/browser-login URL`, sign in manually, and confirm
`/browser-resume`. Then reuse the owned visible session or close it before a
new headless task. The persistent profile keeps login state. The worker never
collects credentials. Direct control handles reviewed actions separately

## Direct control and login

`extensions/lib/browser-control.ts` registers `browser_control` with no nested
model calls or API-key requirement. Worker model and thinking settings do not
apply to direct control. `open` requires an HTTP(S) `url` and defaults to
headless for a new session. `visible` is an open-only option, used only when
requested. Read-only operations include snapshot, text read, exact-ref attribute
inspection, and WebMCP inspection. Interactions use native snapshot refs, not
selectors. Direct `press` also requires a ref and focuses that control first

`/browser-login URL`, `/browser-resume`, and `/browser-close` wrap the same
control operations. Login opens a visible browser without a snapshot and pauses
all automation until resume receives actual UI confirmation. After the resume
command, take a new snapshot before using refs. The user enters
credentials in the browser's native UI. Do not collect credentials, cookies,
tokens, or browser storage. Direct fill blocks known password and OTP fields,
along with file and hidden inputs. This detection is not a complete secrets filter

Every direct click, fill, select, check, uncheck, press, and WebMCP invocation
requires immediate UI confirmation of the exact action and parameters. No UI
means blocked, and there is no model-supplied approval flag. Before ref use, a
fresh snapshot must match the previous URL and exact target signature. For
interactions, the full snapshot must match before and after confirmation.
Changes block execution and require a new review. WebMCP also requires current
inspected metadata and schema-valid arguments. These checks are not atomic
and do not guarantee safe effects or task completion

Uncertain interaction results stop further actions without automatic retry.
The uncertain state persists until confirmed resume or close. Snapshot, read,
and exact-ref inspection remain available for review unless login is paused.
Close affects only the owned browser and preserves the profile

Ownership records use pi custom entries named `browser-owner`, with the daemon
PID, visible mode, login pause, and uncertain state. Session start restores a
record only when its PID matches the live named session. Snapshots and WebMCP
inspection caches are not persisted, so take a new snapshot before using refs
after reload. PID matching is not a cross-process lock. Direct sessions remain
open between calls. On `session_shutdown`, idle owned headless sessions close,
while visible sessions remain open for the user, including across reload

## Shared browser runtime

`extensions/lib/browser-runtime.ts` supplies URL and action validation, bounded
output, CLI batches, and session diagnostics to both tools. The internal helper
`extensions/lib/browser.sh` uses the named `browser` session in the default
namespace. It resolves system Chromium through PATH or
`AGENT_BROWSER_EXECUTABLE_PATH`, with no bundled-browser fallback. Every command,
including close, repeats the same executable, absolute profile, visible mode,
and timeout settings to avoid unintended browser restarts

The separate persistent profile at `~/.pi/agent/browser/profile` keeps browser
data across restarts. The daily browser profile is never used, copied, or
attached. No normal-browser remote-debugging setup is needed.
`--no-startup-window` prevents an extra New Tab page, and additional
`AGENT_BROWSER_ARGS` are retained. The footer counts active agent-browser
sessions. A 10-minute idle timeout is a backstop, including for visible sessions.
Neither tool exposes arbitrary shell, eval, screenshots, or coordinate controls

## WebMCP with DOM fallback

WebMCP is automatic, using agent-browser's experimental native
support. `extensions/lib/browser-webmcp.ts` reads discovery updates from every
batch entry, including `open`, not only the final snapshot. Summaries carry
names, descriptions, origins, and frame IDs. When no update arrives, the existing
catalog stays in use. An unchanged URL and catalog preserve inspected metadata.
A changed URL or catalog invalidates it. Direct controls list native tools on
their first observation if no discovery update arrives, including after a
handoff or reload

The helper prefers suitable page tools and uses `webmcp_inspect` to fetch a
selected tool's full schema. Inspection caches only complete, bounded metadata.
`webmcp_invoke` requires that inspection, a fresh page observation, and a fresh
matching tool record identified by name and frame ID. Parameters are checked
with the SDK validator. Unrecognized schema keywords, missing tools, or stale
metadata cannot be invoked and explicitly direct the worker back to DOM or
inspection. No arbitrary tool name or schema becomes a worker tool definition

A Jev WebMCP choice sends tool inspection and argument selection
to the helper. DOM candidates remain available. Invocations use a 15-second
wait limit within the normal task deadline and return a fresh snapshot. The
worker records invocation identity and status in `webmcpInvocations`

Missing or unsupported WebMCP leaves DOM interaction available. Once invocation
starts, a command error, failed status, timeout, cancellation, or lost response
stops the task. There is no automatic retry or DOM fallback after uncertain
effects. A CLI success envelope alone is insufficient: invocation status must
be `completed`. Tool output remains untrusted evidence, not proof of task success

Descriptions, schemas, results, and annotations such as `readOnlyHint` are page
claims, not authorization. The worker's login and consequential actions retain
the same model-based stop rules as DOM actions. The final read-only phase exposes no
WebMCP invocation, even for tools claiming to be read-only. Fresh metadata checks
are not atomic and do not prove the implementation behind a tool is safe

Uses [agent-browser's native WebMCP interface](https://agent-browser.dev/webmcp)

## Experimental Jev-first selection

Every worker requires `TYPESAFE_API_KEY`. `extensions/lib/browser-jev.ts` sends
the task, URL, focused snapshot, candidates, supplied inputs, and recent history
to TypeSafe's `/v1/systemone` endpoint with `jev-1.13.0`. One request asks
speculative questions for operation, target, and value selection, plus completion
and separate per-candidate relevance and handoff judgments

There is no operation or target-confidence floor. Several next actions can be valid.
For a DOM action, relevance must be at least 0.8 and handoff probability at most
0.1. Fill-value confidence must be at least 0.8. These experimental routing
thresholds are not a safety guarantee or authorization boundary. Uncertain
choices go to the helper. API and response-validation errors fail the task.
TypeSafe requests have a 30-second timeout within the task deadline

DOM candidates are capped at 48, with omissions reported. Candidates include
ref-based interactions, exact-ref inspection, reads, scrolling, and short waits
after interaction. Query controls can use Enter after exact-ref focus. WebMCP
and delegation remain available. Disabled and known protected fields are excluded.
Read-only text fields are not filled, but can still open a picker. For unfamiliar comboboxes and
contenteditable regions, inspect attributes on the exact ref before filling.
Do not infer editability from a role or join controls by their labels. Native
dropdown options use select. Custom listbox options use click

`inputs` maps field meanings to exact nonsecret strings or desired toggle
booleans. Jev selects supplied strings and visible options without generating,
changing, or combining text. If text is missing for a selected field, the helper
gets only `fill_value` and `finish`, with a small field context. It cannot change
the target. Normal delegation allows a bounded action or finish. Both models
receive a compact action history and the last six observations, each capped at
1,500 characters. The field helper gets shorter action history and recent read
evidence. After two identical actions with no observed change, the helper must
choose a different action or stop. The host rejects a third identical action
against that unchanged page state

Focused observations retain useful controls, evidence, and ancestors without
changing native refs. The host retains the full tree for identity checks.
Before any ref action, including a helper action, a fresh snapshot must have the
same URL and target signature. Signatures include target state, ancestors,
nearby heading, and row or list-item record context. Ambiguous refs are skipped,
as are missing or changed targets. These checks are not an atomic page lock

A completion probability of at least 0.9 starts final read-only review. The
helper uses the fresh observation and may make at most two extra read or snapshot
calls before finishing. No mutations or WebMCP invocations are available in this
phase. Insufficient evidence requires a blocked report. All normal final reports
come from the helper, not the completion detector

## Measurement

Results include elapsed, helper, Jev, and browser time, browser call and snapshot
counts, attempted actions, decision steps, model turns, protocol repairs, and
combined usage. Structured decisions record the route and reason, operation,
target and value confidence, relevance, handoff and completion probabilities,
accepted selections, question counts, request size, and candidate omissions.
The thresholds above explain these routing decisions. Fill-generation calls,
delegated steps, stale and repeat skips, and WebMCP invocation identity and status are also
recorded

`firstSnapshotMs` and `lastObservationMs` locate observations.
`completionDetectedMs` marks Jev's preliminary judgment, not proven success.
`completionObservationMs` is the last observation before a final `complete`
report and is null otherwise. `reportMs` covers read-only review or the final
helper call. `cleanupMs` is separate. Offsets include startup. Browser time
includes startup, snapshots, and cleanup, not just worker actions. Check actual
page outcomes separately from model judgments

Usage feeds pi's session totals. Helper costs use the model catalog. Jev uses
the published input price of $0.042 per million tokens, with free output.
These are estimates, not billed charges. There is no separate trace archive or
metrics database

The worker uses pi's extension SDK and agent-browser. Delegation follows this
repository's subagent extension. Speculative routing draws from
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46)
and [TypeSafe's function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling).
Supplied inputs and parallel completion judgment follow
[OpenCode's Jev loop](https://github.com/anomalyco/opencode/blob/021f8b3202a8027b684e43a2e673c269becaf156/packages/plugin-browser/src/use.ts)

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
does not immediately repeat within that category

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
OpenCode Go quota windows. The view is adapted from can1357/oh-my-pi. It does
not scan session use, store totals, or write a cache

Both providers are fetched in parallel with native `fetch` and independent
30-second timeout signals. Closing the panel aborts both requests

- OpenCode Go calls `GET https://opencode.ai/zen/go/v1/usage` with
  `Bearer $OPENCODE_API_KEY` and shows rolling, weekly, and monthly limits
- Codex calls `GET https://chatgpt.com/backend-api/wham/usage`. Credentials,
  OAuth refresh, and `auth.json` updates stay in pi's model registry. The
  request includes the bearer token and `ChatGPT-Account-Id` when available

One provider can fail while the other still renders. Provider response bodies
are capped at 1 MiB before JSON parsing. The panel shows account information,
used bars, free percentages, reset times, status colors, extra Codex feature
limits, and saved reset credits. `[r]` refreshes, `[q]` or Esc closes, duplicate
refreshes are ignored, and results that arrive after close are discarded

# Search extension (`extensions/search.ts`)

## Goal

`web_search` sends one query to Exa and returns a numbered source list. The
calling model writes the answer and cites entries with `[n]`. The API key is
read from `EXA_API_KEY` at call time. There is no config file or auth flow

## Request and result behavior

The extension sends `POST https://api.exa.ai/search` with `x-api-key`,
`type: "auto"`, and `useAutoprompt: false`. `numResults` defaults to 8 and is
capped at 10. `domainFilter` values become allowed domains, or excluded
domains when prefixed with `-`. Day, week, month, and year recency values map
to an ISO UTC `startPublishedDate`

`answer` mode requests excerpts up to 900 bytes. `results` mode requests
compact excerpts up to 250 bytes. Titles are normalized and capped at 200
bytes. Results are deduplicated by URL and capped at 30 sources. The complete
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
↑26 ↓44 $0.000 38,234/1.0M 12.4 tok/s   deepseek-v4-flash • max
```

It removes cache and automatic-compaction segments, adds live throughput, and
uses the active theme

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

The footer runs `agent-browser session list --json` immediately and every 10
seconds. It counts active daemon sessions in the current namespace without
launching a browser. This includes headless, headed, and attached sessions, not
all Chromium processes on the machine. The browser extension uses the default
namespace

When the count is positive, a yellow web icon and count appear directly after
git status. Zero renders nothing. A failed command or invalid response retains
the last count but shows the icon with `?` until polling succeeds. Only one
status process runs at a time, with a 9-second timeout and 4 MiB output cap. The timer stops when the
custom footer is disposed or disabled

# Subagent extension (`extensions/subagent.ts`)

## Goal

`subagent` runs a self-contained task in an isolated pi `AgentSession` and
returns only its final report. The parent context contains the task, returned
report, and usage instead of the full work transcript

## Session design

Each call creates one session in the current project directory. Sibling tool
calls can run concurrently with no shared session state. The subagent gets
`read`, `bash`, `edit`, and `write`, plus `web_search` from an extension filter.
The exact tool allowlist is a second control that
also prevents recursive subagent calls. Skills and project instruction files
still load

Model and thinking resolve independently: per-call override, saved default,
then the caller's setting. `/subagent-model` and `/subagent-thinking` save
`model` and `thinking` in `<agent_dir>/subagent-model.json`, read on each call.
Select a model first. Its initial thinking level is `off`. Both commands share
`extensions/lib/worker-model.ts` and `worker-picker.ts` with the browser commands,
including filtering, validation, and queued configuration writes

A per-call model override must be an exact `provider/model` or an unambiguous
model ID. An explicit reasoning level must be supported by that model. Saved
or inherited thinking is clamped to the selected model. An unavailable saved
model fails the call rather than silently using the caller's model

The model runtime and filtered resource loader are created once per pi process
and shared. Concurrent first calls share the same initialization promise. The
extension filter compares exact source paths, so an unrelated extension with a
matching filename cannot enter the sub-session. Each agent session remains
separate

Transcripts are stored at `<agent_dir>/subagents/<timestamp>_<id>.jsonl` and
link to the parent session when it has a session file. They can be inspected
or opened later with pi's session manager

Text deltas stream to the tool update display. The rolling display keeps at
most the trailing 4,000 characters after its buffer grows past 8,000. The
caller's abort signal calls `session.abort()` during execution. Cancellation
is checked again after session startup, before sending the prompt. A partial
transcript remains on disk after an active run is cancelled, and the
tool reports cancellation after the session stops. Listener removal and
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
