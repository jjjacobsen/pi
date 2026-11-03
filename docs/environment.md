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

## Remote browser

`/remote` needs Pi 1.5.0 or newer for session replacement cleanup, the Tailscale
CLI in Pi's PATH, a connected local Tailscale daemon with an IPv4 address, and a
browser device on the same tailnet. Tailnet ACLs or grants must permit that
device to reach the host's selected port. Each start uses a new available port
No extra npm package, API key, environment variable, or system service is needed

Private browser HTTPS works without Serve when Tailscale HTTPS certificates
are already enabled and the current OS user can run `tailscale cert` for this
node's MagicDNS name. The extension captures PEM output in memory, not files.
The Tailscale daemon can issue and cache certificates in its own state directory
It does not change MagicDNS, tailnet HTTPS settings, daemon permissions, Serve,
or Funnel configuration. On the current host, certificate output to stdout was
verified without configuring Serve

If HTTPS is not enabled, `/remote` uses HTTP bound only to the Tailscale IP and
warns that this is not browser HTTPS. Tailscale still encrypts transport between
devices. Browsers show an insecure HTTP origin. Do not publish or proxy this
listener to another network
For browser HTTPS, the tailnet owner must explicitly enable MagicDNS and HTTPS
certificates, then permit the local user to obtain the node's certificate.
Certificate issuance publishes the node's DNS name in public certificate
transparency logs. See [Tailscale HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates)
If certificate retrieval fails on an enabled node, startup fails with no HTTP
fallback. Long-running listeners do not renew certificates, so stop and restart
before certificate expiry

Keep the displayed link private and stop access when finished. Prompts and tool
output can contain private data. The browser has full prompt control, not a
sandbox. The extension writes no extra session data or credentials to this repo
Normal Pi session persistence is unchanged. Browser state is held only in the
page memory, with caching disabled and no cookies or browser storage. Refreshing
the page requires the private terminal link again. Closing a tab does not stop
the listener. Use `/remote off` or exit Pi

## Local resources

- Obsidian vault: `~/Documents/obsidian`
- Obsidian organizer: `~/Projects/obsidian-organize`
- Anki source notes: `~/Projects/memory`
- TypeSafe skill: `~/.agents/skills/typesafe-ai`
- Pi Voice transcription model, downloaded through `/voice-settings`
