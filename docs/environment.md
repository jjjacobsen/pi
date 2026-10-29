# Environment dependencies

Install or configure only what you use

## API keys and authentication

- Pi provider login for chat and worker models
- `EXA_API_KEY`
- `OPENROUTER_API_KEY` or Pi OpenRouter login
- `OPENCODE_API_KEY`
- `TYPESAFE_API_KEY`
- `X_BEARER_TOKEN` and X OAuth for bookmarks
- `DISCORD_BOT_TOKEN`
- `gh auth login`

## Tools and packages

- Pi 1.4.0 or newer
- mise
- Node.js 24.22.1, pinned in `mise.toml`, and npm
- Bash and Git
- agent-browser and Chrome/Chromium
- agent-device (latest) for the device worker, plus Android SDK platform-tools (`adb`) and a prepared dedicated Android emulator
- pi-voice
- FFmpeg for file transcription
- lazygit
- Neovim
- PipeWire on Linux or `afplay` on macOS
- `xdg-open` on Linux or `open` on macOS
- GitHub CLI (`gh`)

## Browser and device workers

Keep the CLIs shared through mise so workers can use them from any project
The existing browser setup uses `npm:agent-browser` in global mise settings
Install the reviewed device CLI the same way, outside this package's npm dependencies

```bash
mise use -g npm:agent-device@latest
mise x -- agent-device --version
```

This version is verified against npm's `latest` tag and Callstack's
[installation guide](https://agent-device.dev/docs/installation). It requires
Node.js 22.12 or newer. This repo's Node.js version meets that requirement
Do not install a newer mutable version without review

Before the first delegated task, prepare the dedicated emulator and run
`mise x -- agent-device doctor` yourself. This setup check is not automatic
Keep `adb` and the Android SDK available in Pi's environment, using the existing
`ANDROID_HOME` or `ANDROID_SDK_ROOT` configuration where required. Do not change
physical devices. Device calls require an explicit `emulator-NNNN` serial
The first Android snapshot can install or update the bundled helper APK on
that emulator. The worker opts out of the separate headless test keyboard
No cloud account or extra API key is needed for local emulator control

Pi inherits CLI availability when it starts. Restart Pi from a mise-enabled
shell if it cannot find a newly installed CLI. Otherwise `/reload` loads the new
extension. Select `/device-model`, then `/device-thinking`. Worker settings are
saved at `<agent_dir>/device-model.json`, normally `~/.pi/agent/device-model.json`
The package already registers all of `./extensions`, so no new resource entry
is needed. Browser and device screenshot evidence uses Pi's built-in image
resize and native tool images, with no extra package. Previews need a model
with image input and terminal image support for inline display. Saved image
paths still work without inline display. Images can contain private data and
go to both selected model providers

## Local resources

- Obsidian vault: `~/Documents/obsidian`
- Obsidian organizer: `~/Projects/obsidian-organize`
- Anki source notes: `~/Projects/memory`
- TypeSafe skill: `~/.agents/skills/typesafe-ai`
- Pi Voice transcription model, downloaded through `/voice-settings`
