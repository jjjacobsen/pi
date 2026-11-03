import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

// Read Pi Voice's settings, but use only transcribe-cpp's public package API
export async function transcribeRemoteAudio(request: IncomingMessage, signal: AbortSignal) {
  const agentDir = join(homedir(), ".pi", "agent");
  const settings = JSON.parse(await readFile(join(agentDir, "pi-voice.json"), "utf8").catch((error) => {
    throw new Error(`Cannot read Pi Voice settings: ${error.message}`);
  }));
  if (settings.version !== 1) throw new Error("Unsupported Pi Voice settings version");
  if (settings.backend?.type !== "transcribe-cpp") throw new Error("Remote voice requires the Pi Voice transcribe-cpp backend");
  if (!settings.model?.path) throw new Error("Select and download a Pi Voice model with /voice-settings first");
  if (typeof settings.transcriptionLanguage !== "string") throw new Error("Pi Voice transcriptionLanguage is missing");
  await access(settings.model.path).catch(() => { throw new Error("Pi Voice model is missing or unreadable. Check /voice-settings"); });
  await access("/usr/bin/ffmpeg").catch(() => { throw new Error("Remote voice requires /usr/bin/ffmpeg"); });
  const modulePath = join(agentDir, "npm", "node_modules", "transcribe-cpp", "dist", "index.js");
  await access(modulePath).catch(() => { throw new Error("The installed public transcribe-cpp module is missing from ~/.pi/agent/npm/node_modules"); });
  const moduleUrl = pathToFileURL(modulePath).href;

  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "pi-remote-voice-"));
  try {
    const file = join(directory, "recording");
    const upload = createWriteStream(file, { mode: 0o600 });
    await pipeline(request, upload, { signal });
    if (!upload.bytesWritten) throw new Error("Audio recording is empty");
    signal.throwIfAborted();
    const pcmFile = join(directory, "audio.f32le");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/ffmpeg", [
        "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", file,
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", pcmFile,
      ], { signal, killSignal: "SIGKILL", stdio: ["ignore", "ignore", "pipe"] });
      let stderr = Buffer.alloc(0);
      child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(-16 * 1024); });
      let failure: Error;
      child.once("error", (error) => { failure = error; });
      // Wait for close, including on abort, before removing the temporary files
      child.once("close", (code) => {
        const detail = stderr.toString("utf8").trim();
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Cannot decode audio with FFmpeg (exit ${code})${detail ? `: ${detail}` : ""}`));
        else resolve();
      });
    });
    const { size } = await stat(pcmFile);
    if (!size || size % 4) throw new Error("Recording contains no valid audio");
    signal.throwIfAborted();
    const pcm = new Float32Array(size / 4);
    const bytes = new Uint8Array(pcm.buffer);
    let offset = 0;
    // Fill the native input directly, without readFile's fixed per-file ceiling
    for await (const chunk of createReadStream(pcmFile, { signal })) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    signal.throwIfAborted();
    const { TranscribeModel } = await import(moduleUrl);
    const model = await TranscribeModel.load(settings.model.path);
    try {
      signal.throwIfAborted();
      const result = await model.transcribe(pcm, {
        language: settings.transcriptionLanguage === "auto" ? undefined : settings.transcriptionLanguage,
        timestamps: "none", signal,
      });
      signal.throwIfAborted();
      if (result.aborted || result.truncated) throw new Error("The model did not finish transcription");
      return result.text.trim();
    } finally { model.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
