# Installed pi packages

Mirror of the `packages` list in `~/.pi/agent/settings.json`. Refresh this
file whenever packages change. Additional package notes are below

## 3rd party packages

- `npm:@earendil-works/pi-voice`

## Local installs

| Path | Purpose |
| ---- | ------- |
| `../../Projects/pi` | this repo, dev install |
| `../../Projects/obsidian-organize` | Obsidian skill and native review extension |

## Package notes

### Pi Voice

- [Pi Voice](https://github.com/earendil-works/pi-voice) by earendil-works, the pi maintainer
- Install: `pi install npm:@earendil-works/pi-voice`
- Commands: `/voice` for dictation and `/voice-settings` for setup
- Tool: `transcribe_file` for local audio or video files
- Shortcut: `ctrl + alt + z`
- [Environment requirements](environment.md#voice-configuration)
- Use speech-to-text for input and read the output, rather than wait for spoken responses. This is the optimal interface setup
