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
