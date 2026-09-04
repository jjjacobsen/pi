# Papercuts

## 2026-08-13

- The pi vision tool (describe_image) returned "Vision model returned no
  content" for a Ghostty TUI screenshot; OCR'd it with a one-off Swift
  script using the Vision framework (`VNRecognizeTextRequest`, accurate
  level) instead. Useful technique for TUI/terminal screenshots.
- sips defaults its OUTPUT format to the INPUT format, and its WebP writer is
  broken ("Can't write format: org.webmproject.webp"). Resizing a WebP
  without an explicit `-s format` fails, so the `-s format` flag must always
  be passed (jpeg/png/gif). Also: an alpha WebP comes back as PNG, so the
  data-URL mime must follow what sips produced, not the input mime.
- VP8X chunk layout: flags at chunk+8, canvas width at chunk+12, height at
  chunk+15 (the header is 8 bytes, the payload 10). Reading them 12 bytes too
  far reaches the next chunk and produces garbage dimensions and a wrong
  alpha flag for extended WebP files; only a real-file test caught it.

## 2026-08-15 (extension glue gotchas)

- pi's `getArgumentCompletions` must return `AutocompleteItem[]`
  (`{value, label, description?}`), not plain strings. Strings crash the
  TUI with an uncaught `TypeError: Cannot read properties of undefined
  (reading 'length')` in pi-tui's select-list `visibleWidth`. The docs
  example shows the shape but the crash message gives no hint.
- GNU `timeout` is not on macOS. Shell tests that rely on it fail with
  `command not found`; use a background process + `sleep` + `ps` + `kill`
  instead.

## 2026-08-15

- `PI_TIMING=1` startup timings are swallowed when the TUI runs: the timings
  print into the alternate screen buffer, then the teardown escape sequence
  wipes them. Run `PI_TIMING=1 pi -p "hi"` (print mode) and read stderr
  instead; the `extensions` namespace breaks down per-extension import cost.

## 2026-08-15 — Exa search rewrite

- Sourcing `~/.zshrc` inside a bash tool session dies silently before the
  next command runs: the `eval "$(fnox activate zsh)"` and `eval "$(mise
  activate zsh)"` hooks plus zsh-only syntax (`autoload`, `bindkey`,
  `(( ... ))`) abort the whole script under bash, and earlier commands that
  did survive left the session in a broken state. Fix: don't source it,
  copy the needed export inline (`export EXA_API_KEY="..."`).

## 2026-08-16

- `git merge` refuses outright when a file the merge rewrites has uncommitted
  local changes ("Your local changes ... would be overwritten by merge"),
  even when the local diff and the merge both touch disjoint regions of the
  file.
  Fix: `git stash push`, merge, resolve, `git stash pop` — the pop
  auto-merges the local diff back in, and the working tree ends up identical
  to what you had.

## 2026-08-17

- TypeScript 6.0 flips `strict` on by default (tsconfigs that omit it are strict), and it no longer infers `never` for un-annotated throwing functions, so `return throwFn()` poisons an async function's inferred return into `void | T` and breaks tool-executor registration against `AgentToolResult`. Annotate the thrower as `: never`. Diagnosed by bisecting a repro against the real pi types; TS 5.9 does not have either behavior.
- tsconfig `paths` does not consult the target package's `exports` map: `@earendil-works/pi-ai/compat` mapped to the package dir fails because the file lives at `dist/compat.d.ts`. A package-specific entry mapping `@earendil-works/pi-ai/*` into `dist/` fixes subpath imports. Order does not matter, TS falls through a pattern whose target does not resolve to the next one (verified after `jq -S` reordered the entries).
- `hk fix -S jq -S newlines` on a new tsconfig.json: the write tool emits no trailing newline (newlines step fails) and `Builtins.jq` (`jq -S`) wants multi-line array formatting, so a fresh JSON file fails the check until both fixers run once.
- `bun`'s global install serves as the type source: `strict: false` + `paths` + `typeRoots` pointing at `~/.bun/install/global/node_modules` give the extension glue its types with no local `node_modules`, but the config is machine-specific and breaks on any clone lacking that install (documented in docs/architecture.md).

## 2026-08-18

- A multi-edit `edit` call is atomic: when one `oldText` matches multiple
  locations, the whole call is rejected and NONE of the edits apply,
  including the ones that were unique. After a rejected multi-edit, grep to
  confirm nothing partial landed before re-submitting with unique context
  anchors.
- `pi.exec` result shape quirk: on a signal death (timeout or abort), the
  exit `code` comes back as 0 with `killed: true` because the code is null
  for signal terminations and execCommand substitutes 0. Check `res.killed`
  before trusting the exit code, or a killed process looks like an empty
  success.
- `cd` persists across `bash` tool calls in this harness. In one smoke-test
  batch, a command changed to `/tmp` and subsequent relative-path
  invocations failed with "No such file or directory". Use absolute paths
  (or `pushd`/`popd`) in multi-step test commands.
- macOS has no GNU `timeout` (`timeout: command not found`). To bound a
  blocking command, run it in the background, `sleep`, `kill`, then `wait`.
- Smoke-testing commands with a pipe to `head` reports `head`'s exit code,
  not the command's: a failing operation can look like exit 0. Redirect to a
  file (or use `${PIPESTATUS[0]}`) when the exit code matters.

## 2026-08-20 — npm install-script approval

- npm 11.19.0's `npm install-scripts approve koffi --dry-run --json`
  still edited `package.json`. The working tree was clean immediately before
  the command. Inspect the diff after approval previews instead of assuming
  `--dry-run` is read-only.

## 2026-08-20 — SDK exact model resolver is internal

- `findExactModelReferenceMatch` exists in pi's internal model-resolver module
  but is not exported from the package root, so importing it from
  `@earendil-works/pi-coding-agent` failed the full TypeScript check. Use the
  public `ModelRuntime.getModels()` catalog and match `provider/model` first,
  then an unambiguous exact model ID.

## 2026-08-29

- `Object.entries(auth.headers)` inferred each provider header as `unknown`,
  even though runtime values are `string | null`, so filtering out `null` did
  not make `Object.fromEntries` assignable to fetch's string header record.
  Build a `Record<string, string>` in a loop and copy only string values.

## 2026-09-02

- Playwright CLI 0.1.18 defaults to the Google Chrome channel at
  `/opt/google/chrome/chrome`, but Omarchy supplies Chromium at
  `/usr/bin/chromium`. Setting
  `PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium` on `open` uses the system
  browser successfully and avoids a separate browser download.

## 2026-09-04

- pi 0.85.0 added `EditorOptions.embedWorkingStatus`, but this repo still uses
  0.84.4 development types. Passing the new runtime option failed `tsc` until
  the options object was cast to `any`. Remove the cast when the development
  dependencies move to 0.85.0 or newer.
- The mise pi installation is a compiled binary distribution without the
  TypeScript source tree. Trying to inspect the launcher with `head` printed
  binary data. Fetch source files from the matching `v<version>` tag in the
  official repository instead.
