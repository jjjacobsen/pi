# Personal pi settings

Merge these preferences into `~/.pi/agent/settings.json` on each computer, then
run `/reload`. Keep existing machine-specific settings. Pi does not load this
file automatically

```json
{
  "defaultTools": ["+codemode", "+grep", "+find"],
  "hideThinkingBlock": false,
  "showHardwareCursor": true,
  "tuiMode": "fullscreen",
  "fullscreenWheelScrollLines": 1,
  "fullscreenExitOutput": "resume-hint"
}
```

- Enable codemode and native file search with `grep` and `find`
- Use the terminal cursor, with its shape set by the terminal
- Use fullscreen mode with visible thinking and one line per wheel event
- Print a resume hint instead of the transcript when exiting fullscreen mode

Theme, skill paths, package configuration, and `lastChangelogVersion` stay local

## Keybindings

Merge these into `~/.pi/agent/keybindings.json`, then run `/reload`

```json
{
  "tui.altScreen.pageUp": [],
  "tui.altScreen.pageDown": [],
  "tui.altScreen.halfPageUp": "pageUp",
  "tui.altScreen.halfPageDown": "pageDown",
  "tui.altScreen.top": "home",
  "tui.altScreen.bottom": "end"
}
```

- Page Up/Down scroll the conversation by half a page
- Home/End jump to the conversation start/end
- On Mac, use Fn with the arrow keys: up/down for Page Up/Down, left/right for Home/End
