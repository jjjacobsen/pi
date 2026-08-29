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
- `registerTerminalCommand` provides the shared TUI validation, terminal
  handoff, restoration, and result notification used by `/lg` and `/nvim`

`extensions/lib/toolkit.ts` contains two groups of helpers

- `toolError` throws tool failures, and `toToolUsage` converts delegated model
  tokens to pi usage and calculates cost from the model pricing
- The Codex helpers choose a subscription model, resolve credentials through
  pi, and read the account ID and email from the OAuth token

The extension imports live in bun's global install at
`~/.bun/install/global/node_modules`. Pi aliases these packages to its bundled
copies at runtime. `tsconfig.json` points its `paths` and `typeRoots` at the
same global install so editor and command-line types match the running pi
version. These absolute paths are machine-specific

`strict: false` is explicit because the extension code is deliberately light
on annotations. `hk.pkl` runs `tsc --noEmit -p tsconfig.json`, and `mise.toml`
pins the TypeScript version. `mise x -- hk check --all` must stay green

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

The prompt can include `/commit` arguments as intent and the last 12 user or
assistant session entries, capped at 4,000 characters. The diff remains the
source of truth

Small diffs up to 6 KiB are sent as-is. Larger diffs become a declaration-like
digest with at most 8 hunks and 14 selected lines per file. The digest is
capped at 12 KiB and the complete model context at 24 KiB. Git stdout is
normally capped at 32 MiB, stderr at 16 KiB, and smaller metadata calls use
lower caps. Commit guidance is capped at 2 KiB

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

The 33 WAV files live in `assets/peon/` and are played directly with macOS
`afplay`. The sound packs are Orc Peon by tonyyont and Human Peasant by
thomasKn from OpenPeon CESP, licensed CC-BY-NC-4.0

Config is `<agent_dir>/peon.json`

- `volume`, set by the UI from 10% through 100%, with 50% as the default
- `paused`, false by default
- `silent_window_seconds`, 0 by default
- `annoyed_threshold`, 3 by default
- `annoyed_window_seconds`, 10 by default
- One enabled flag for each of the five categories

The settings panel changes pause state, volume, silent window, and category
flags. Config writes replace the file directly. A missing or invalid config
uses defaults and logs non-missing-file errors. Settings-save failures are
shown as UI errors

Cross-event state is `<agent_dir>/peon-state.json`

- Last sound index for each category
- A 16-entry ring of prompt timestamps
- Last agent start and last completion time

State loads before each event and is written through a temporary file after it.
The final rename is best-effort, matching the previous notification behavior.
Invalid state uses defaults and logs the problem. Other state-save failures are
logged but do not break the lifecycle event. A promise queue serializes events
so two state read and write cycles do not overlap. The active `afplay` child is
kept only in process memory, so Peon never signals a PID restored from disk

## Event behavior

- `session_start` plays for every start reason, including reload
- `agent_start` records the start and prompt time, then plays rapid-spam audio
  when the configured number of prompts falls in the configured window.
  Otherwise it plays acknowledgement audio
- A failed tool execution plays task-error audio
- `agent_end` plays completion audio only when the last assistant stop reason
  is not `error`, at least 5 seconds passed since the previous eligible end,
  and the run met the silent-window duration

Paused or disabled categories do not play. Before a new sound starts, the
extension sends `SIGTERM` to the recorded player PID. It starts `afplay`
detached with ignored standard streams, calls `unref`, and records the new PID
so voice lines do not overlap. Spawn failures log one line and do not break pi

Lifecycle sounds run only in sessions with a UI

# Status extension (`extensions/status.ts`)

## Goal and behavior

`/status` opens a TUI panel with current OpenAI Codex subscription and
OpenCode Go quota windows. The view is adapted from can1357/oh-my-pi. It does
not scan session use, store totals, or write a cache

Both providers are fetched in parallel with native `fetch` and independent
30-second timeout signals

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

# Vision extension (`extensions/vision.ts`)

## Goal

`describe_image` lets a text-only primary model delegate image analysis to a
configured image-capable model. For an image-capable primary, the tool is
hidden and pi sends images to the model natively

## Tool visibility and config

Tool visibility is synchronized on session start and model selection. When an
image is attached to a text-only primary, the input hook adds a short hint so
the model knows to call `describe_image`. The hint reports when no vision model
is configured

Config is `<agent_dir>/vision.json` with `provider`, `model`, `maxDimension`,
and `jpegQuality`. Defaults are 1568 pixels and quality 85. Unknown old keys
are ignored. A missing file uses defaults, while invalid or unreadable config
also uses defaults and logs the error. `/vision show` displays the selection,
`/vision model` opens a picker of image-capable registry models, and
`/vision model <provider/model>` validates and saves an exact choice

At each call, the extension resolves the selected model and its credentials
through pi's model registry. Provider headers are preserved. An Authorization
bearer is added only when the resolved headers do not already contain one

## Image processing

Paths can be absolute or relative to the current working directory. Source
files are capped at 64 MiB. Format and dimensions are detected from header
bytes for PNG, JPEG, GIF, and WebP

An image at or below the configured dimensions and below 10 MiB is sent
byte-for-byte. Larger images use macOS `sips -Z`

- Opaque input becomes JPEG at the configured quality
- GIF with transparency stays GIF
- Transparent PNG and WebP become PNG because `sips` cannot write WebP
- Temporary output is removed in a `finally` block and is also capped at
  64 MiB

The request is an OpenAI-compatible `POST <baseUrl>/chat/completions` with a
base64 data URL, the user prompt, `max_tokens: 4096`, and `temperature: 0`.
Response content can be a string or an array of text, thinking, or reasoning
blocks. `reasoning_content` is used when normal content is empty

Response bodies are capped at 1 MiB. Invalid successful JSON includes at most
400 raw characters in the error. Non-success responses include the provider
error message when available

## Timeout, retry, cancellation, and usage

The full tool execution has a 60-second abort controller. It combines config,
auth resolution, image work, the request, retry delay, and response reading.
The caller's cancellation aborts the same controller, including `fetch`, file
reads, and `sips`

The request retries once after 500 ms for HTTP 429, HTTP 5xx, and network
`TypeError` failures. Other HTTP failures, timeouts, content errors, and parse
errors from successful responses do not retry

Prompt and completion tokens from the delegated response are converted to pi
tool usage. Cost is calculated from the selected model's pricing, so image
analysis appears in session totals

The compression path requires macOS `sips`. Supported images that do not need
compression do not call it

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
π  ~/Projects/pi  main *1 ?2 +1
↑26 ↓44 $0.000 38,234/1.0M 12.4 tok/s   deepseek-v4-flash • max
```

It removes cache and automatic-compaction segments, adds live throughput, and
uses the active theme

## Data and lifecycle

Session input, output, and cost totals include assistant messages, tool
results, compactions, and branch summaries. Context use comes from
`ctx.getContextUsage()`. It shows `?/window` immediately after compaction until
the next response provides verified use

Context color uses absolute thresholds of 100,000 tokens for warning and
200,000 for error. For smaller windows, 60% and 90% are fallback thresholds

Pi supplies the branch, provider count, and extension statuses. The extension
runs `git --no-optional-locks status --porcelain -b` when enabled, on branch
changes, and every 5 seconds. Only one status process runs at a time, and each
has a 4-second timeout. It counts files with unstaged work as `*N`, untracked
files as `?N`, and staged files as `+N`. The interval and branch listener are
removed when the footer is disposed or disabled

Throughput estimates one token per four streamed text or thinking characters.
It uses a rolling 15-second sample window, ignores gaps longer than 2 seconds,
and waits for 2 seconds of active data before updating. It starts at `0.0` for
each session, updates during streaming, and freezes the last value when idle.
A short stream uses its overall average

The model and thinking level are right-aligned. The provider is shown when
more than one provider is available. Extension statuses use a third line

The footer starts automatically for TUI sessions. `/footer` switches between
it and the built-in footer. Message, model, thinking, session-info, compaction,
branch, and git-status changes request a render

# Subagent extension (`extensions/subagent.ts`)

## Goal

`subagent` runs a self-contained task in an isolated pi `AgentSession` and
returns only its final report. The parent context contains the task, returned
report, and usage instead of the full work transcript

## Session design

Each call creates one session in the current project directory. Sibling tool
calls can run concurrently with no shared session state. The subagent gets
`read`, `bash`, `edit`, and `write`, plus `web_search` and `describe_image`
from an extension filter. The exact tool allowlist is a second control that
also prevents recursive subagent calls. Skills and project instruction files
still load

The model and thinking level inherit independently from the caller. A model
override must be an exact `provider/model` or an unambiguous model ID. An
explicit reasoning level must be supported by that model. When only the model
changes, pi clamps the inherited level to the selected model

The model runtime and filtered resource loader are created once per pi process
and shared. Each agent session remains separate

Transcripts are stored at `<agent_dir>/subagents/<timestamp>_<id>.jsonl` and
link to the parent session when it has a session file. They can be inspected
or opened later with pi's session manager

Text deltas stream to the tool update display. The rolling display keeps at
most the trailing 4,000 characters after its buffer grows past 8,000. The
caller's abort signal calls `session.abort()`. A partial transcript remains on
disk, and the tool reports cancellation after the session stops

The final assistant text is truncated with pi's standard tool-result limit.
When truncation occurs, the result includes counts and the transcript path.
Every result also includes the effective model, reasoning level, and
transcript path. Assistant-message usage across the child session is summed
and returned so pi includes subagent cost in the parent totals

Concurrency is not limited in code. Provider rate limits are the practical
limit
