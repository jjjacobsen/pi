---
name: browser
description: Automate websites with the installed Playwright CLI through compact accessibility snapshots and deterministic element references. Use for browser navigation, authenticated website tasks, form entry, web application inspection, and browser-based verification. Run headless by default and use a short headed handoff only when Jonah must sign in manually.
compatibility: Requires playwright-cli on PATH
metadata:
  author: jonah
  version: "1.0.0"
---

# Browser

Use the installed `playwright-cli` directly through Bash. This workflow is
adapted from the official Microsoft Playwright CLI skill at
https://github.com/microsoft/playwright-cli

Use the single named session `browser` for every command. Do not create a
custom profile directory. `--persistent` lets Playwright manage the profile in
its operating-system cache and preserves browser authentication across restarts

Set `PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium` when opening the browser
to use Omarchy's system Chromium instead of installing a separate Playwright
browser or Google Chrome. Set
`PLAYWRIGHT_MCP_OUTPUT_DIR="$HOME/.pi/agent/playwright"` so generated snapshots
and other output never enter the current project

## Rules

- Run headless by default. Do not pass `--headed` unless Jonah explicitly needs
  to sign in or asks to see the browser
- Use the persistent profile for authenticated and potentially authenticated
  work. Never use Jonah's normal Chrome profile or attach to his normal browser
- Never ask Jonah to send credentials, passwords, passkeys, or MFA codes. Use
  the headed authentication handoff below
- Do not inspect, print, save, or copy cookies, authentication state, local
  storage, or session storage unless Jonah explicitly requests it
- Use accessibility snapshots and element refs instead of screenshots, visual
  guessing, CSS selectors, or mouse coordinates
- Keep generated snapshots and other output under `~/.pi/agent/playwright/`.
  Never write or commit `.playwright-cli/` artifacts in the current project
- Use `find` or a partial snapshot before reading a large full-page snapshot
- Take a new snapshot after navigation or a meaningful page change. Old refs
  can become invalid
- Use `eval` only when the accessibility tree does not expose required DOM
  information
- Do not use screenshots for validation. Use them only when the task itself
  requires image output or the page is fundamentally visual, such as a canvas
- Ask immediately before a consequential final action such as sending a
  message, publishing, purchasing, deleting remote data, or submitting a
  non-reversible form
- Close the browser when the task is complete. Never run `delete-data`,
  `cookie-clear`, `state-save`, `close-all`, or `kill-all` unless Jonah
  explicitly requests it

## Headless workflow

Open the managed persistent browser without showing a window

```bash
PLAYWRIGHT_MCP_OUTPUT_DIR="$HOME/.pi/agent/playwright" \
  PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium \
  playwright-cli -s=browser open "https://example.com" --persistent
```

Use the snapshot path returned by each command, or request a focused view

```bash
playwright-cli -s=browser find "Sign in"
playwright-cli -s=browser snapshot --depth=4
playwright-cli -s=browser snapshot e12
```

Interact through current refs

```bash
playwright-cli -s=browser click e12
playwright-cli -s=browser fill e18 "value"
playwright-cli -s=browser press Enter
playwright-cli -s=browser select e24 "option-value"
playwright-cli -s=browser check e30
```

Useful inspection commands

```bash
playwright-cli -s=browser tab-list
playwright-cli -s=browser console error
playwright-cli -s=browser requests
playwright-cli -s=browser eval "document.title"
```

Close the browser process while retaining its managed profile

```bash
playwright-cli -s=browser close
```

## Manual authentication handoff

Use this only when authentication is required and the persistent profile is not
already signed in

1. Close the headless browser if it is open

```bash
playwright-cli -s=browser close
```

2. Open the sign-in page in a visible browser

```bash
PLAYWRIGHT_MCP_OUTPUT_DIR="$HOME/.pi/agent/playwright" \
  PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium \
  playwright-cli -s=browser open "https://example.com/login" --persistent --headed
```

3. Stop and ask Jonah to complete sign-in in the browser window. Do not operate
   the browser until he confirms that sign-in is complete
4. After confirmation, close the visible browser and reopen the target page
   headless with the same managed profile

```bash
playwright-cli -s=browser close
PLAYWRIGHT_MCP_OUTPUT_DIR="$HOME/.pi/agent/playwright" \
  PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium \
  playwright-cli -s=browser open "https://example.com" --persistent
```

5. Confirm authentication from the accessibility snapshot, then continue

## Large pages

Search before loading a large snapshot into context

```bash
playwright-cli -s=browser find "Account settings"
playwright-cli -s=browser find --regex "/save|submit/i"
```

Use `--raw` only when concise command output is needed for a pipeline. Do not
print a large raw snapshot into model context

```bash
playwright-cli -s=browser --raw eval "document.title"
```
