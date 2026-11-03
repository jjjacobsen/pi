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

`/remote` needs Pi 1.5.0 or newer for session replacement lifecycle events, the Tailscale
CLI in Pi's PATH, a connected local Tailscale daemon with an IPv4 address, and a
browser device on the same tailnet. Tailnet ACLs or grants must permit that
device to reach the host's selected port. Each start uses a new available port
QR display also needs the local `qrencode` command in Pi's PATH. Without it,
the text link still works. No QR data goes to a network service or file
The non-blocking QR widget needs enough terminal space for the whole code and
editor. `/remote hide` hides it without stopping access. Browser connection
also hides it
Text, images, and Changes need no extra npm package, API key, environment
variable, or system service
The read-only Changes viewer needs Git in Pi's PATH and a repository in the
current session directory. It uses the same authenticated listener and reads
only changed files in that repository. No GitHub service or credentials are
needed. Refresh after file changes. Missing repositories, binary files, deleted
source, symbolic links, and size limits show messages instead of content
Image input uses Pi's built-in resize helper. Select a model with image input
and keep `images.blockImages` false. The Image button uses the native file
picker, without forced camera capture. Image paste depends on what the browser
and OS expose in the clipboard. PNG, JPEG, and WebP are supported. Native browser
image and canvas APIs resize originals over 10 MiB before upload, without extra
dependencies. The uploaded image must fit the server's 10 MiB limit. Images that
the browser cannot decode or resize stay unsent with an error
Submitted images go to the model provider and normal Pi session storage
After updating an already-running remote listener, use `/remote off`, then
`/remote` to apply the image-preview CSP and upload timeout if not already done
For uncapped voice, run `/reload`, `/remote off`, then `/remote` and open the new
link. Refresh the phone page. The listener must restart to replace the shared
upload timeout with a per-request deadline that exempts authenticated voice

Voice needs browser HTTPS, microphone permission, and MediaRecorder support
for WebM/Opus or MP4, including Safari's MP4 recording. HTTP over Tailscale is
not a secure browser context and cannot use the microphone
The host needs `/usr/bin/ffmpeg`, the installed public module at
`~/.pi/agent/npm/node_modules/transcribe-cpp/dist/index.js`, its native runtime, and
`~/.pi/agent/pi-voice.json` version 1 with `backend.type: transcribe-cpp`, a
readable local `model.path`, and `transcriptionLanguage`. Select and download
the model through `/voice-settings` first. Settings are read for each request
No Pi Voice source is imported or changed, and no model is downloaded by remote
Other backends fail with an error. The separate remote model adds memory use
and load time, with one remote request at a time and disposal after each request
Voice has no imposed recording duration, audio byte cap, upload deadline, FFmpeg
deadline, or processing timeout. Encoded uploads stream to disk, and FFmpeg writes
the full decoded PCM to disk before inference. Allow disk space for both files
Browser recording memory, host RAM/disk, runtime buffer limits, and model limits
still apply. PCM needs 64,000 bytes per second, about 38.4 MB for ten minutes,
plus native model compute memory. The native call borrows a full Float32Array
The current Parakeet Unified model reports no audio-length cap through the public
API, but its offline full-attention pass can exhaust memory on long recordings
Other models can have input or output limits. See the upstream
[audio input limits](https://github.com/handy-computer/transcribe.cpp/blob/main/docs/input-limits.md)
Native model loading has no abort API. Cancellation waits for load to finish,
then disposes the model before another request can start
Cancel voice during recording discards audio without upload. Leaving the page,
connection loss, or session replacement also discards recording
Stop recording uploads once, appends the transcript to current typed text, and
never sends it. Temporary host audio files are removed after processing
Audio never enters Pi history. Transcript text enters normal Pi history only
when the user presses Send

Load this extension globally to keep access working when a terminal session
switch enters another working directory. If the replacement runtime does not
load it, the listener cannot bind to that session and shows a transition status
until the extension loads again or the process exits

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

Keep the displayed link and QR code private and stop access when finished. Prompts and tool
output can contain private data. The browser has full prompt control, not a
sandbox. The extension writes no extra session data or credentials to this repo
Normal Pi session persistence is unchanged. The browser keeps its credential in
same-tab `sessionStorage` so refresh restores access, with caching disabled and
no cookies or `localStorage`. A new private link replaces the old credential
Phone sleep or a network change can pause polling. Polling retries automatically
Reconnect or refresh also works. None of these paths resend prompts or commands
Tab closure or mobile OS eviction can require the private terminal link again,
but does not stop Pi or the listener. Session replacement and reload keep the
same listener, link, and browser credential. `/remote off` and process exit close
access and invalidate the link

Type `/` or use the `/` button beside the composer for remote commands. New,
reload, and resume use Pi's supported command-context methods. Resume lists
saved sessions in the current working directory and honors the active session
storage directory. Other listed commands come from loaded extensions, skills,
and templates. Commands require idle Pi. Other terminal built-ins and extension
dialogs are not implemented in the browser. A command can still need terminal
confirmation. Do not retry a command after a timeout until you check the current
session, since it can have completed

## Local resources

- Obsidian vault: `~/Documents/obsidian`
- Obsidian organizer: `~/Projects/obsidian-organize`
- Anki source notes: `~/Projects/memory`
- TypeSafe skill: `~/.agents/skills/typesafe-ai`
- Pi Voice transcription model, downloaded through `/voice-settings`
