# Installed pi packages

Mirror of the `packages` list in `~/.pi/agent/settings.json`. Refresh this
file whenever packages change. Additional package notes are below

## 3rd party packages

- @ff-labs/pi-fff (npm)
- pi-transcribe (git)

## Local installs

| Path | Purpose |
| ---- | ------- |
| `../../Projects/pi` | this repo, dev install |

## Package notes

### pi-transcribe

- [pi-transcribe](https://github.com/earendil-works/pi-voice) by earendil-works, the pi maintainer
- Install: `pi install npm:@earendil-works/pi-voice`
- Command: `/transcribe`
- Shortcut: `ctrl + alt + z`
- Use speech-to-text for input and read the output, rather than wait for spoken responses. This is the optimal interface setup
