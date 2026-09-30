# Personal pi settings

Merge these preferences into `~/.pi/agent/settings.json` on each computer, then
run `/reload`. Keep existing machine-specific settings. Pi does not load this
file automatically

```json
{
  "hideThinkingBlock": false,
  "tuiMode": "fullscreen",
  "fullscreenWheelScrollLines": 1,
  "fullscreenExitOutput": "resume-hint"
}
```

- Use fullscreen mode with visible thinking and one line per wheel event
- Print a resume hint instead of the transcript when exiting fullscreen mode

Theme, skill paths, package configuration, and `lastChangelogVersion` stay local
