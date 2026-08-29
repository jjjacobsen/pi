// pi-commit: /commit implemented directly in TypeScript.
// Inspired by tmonk/pi-committer (https://github.com/tmonk/pi-committer).

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_WIDGET = "commit";

function showSpinner(ctx, label) {
  try {
    ctx.ui.setWidget(SPINNER_WIDGET, (tui, theme) => {
      const text = new Text(theme.fg("dim", `${SPINNER_FRAMES[0]} ${label}`), 1, 0);
      let frame = 0;
      const timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        text.setText(theme.fg("dim", `${SPINNER_FRAMES[frame]} ${label}`));
        tui.requestRender();
      }, 80);
      return Object.assign(text, { dispose: () => clearInterval(timer) });
    });
  } catch {
    // headless sessions have no widgets
  }
}

function hideSpinner(ctx) {
  try {
    ctx.ui.setWidget(SPINNER_WIDGET, undefined);
  } catch {
    // headless sessions have no widgets
  }
}

const THINKING_LEVEL = "low";
const MAX_SESSION_TAIL = 4000;
const MAX_INTENT = 2 * 1024;
const TIMEOUT_MS = 60000;
const MAX_GIT_OUT = 32 * 1024 * 1024;
const RAW_DIFF_LIMIT = 6 * 1024;
const DIGEST_LIMIT = 12 * 1024;
const CONTEXT_LIMIT = 24 * 1024;
const TYPES = new Set(["feat", "fix", "docs", "refactor", "test", "perf", "ci", "chore", "build", "style", "revert"]);

const SYSTEM_PROMPT = `You write precise Conventional Commits for a git repository.

Rules:
- Header: <type>(<scope>): <imperative summary>. Keep it under 72 characters, never over 100.
- Allowed types: feat, fix, docs, refactor, test, perf, ci, chore, build, style, revert.
- Use a scope only when it clearly names the changed area (module, feature, component).
- The summary must be specific and evidence-based. Never use vague wording like "update files" or "misc changes".
- The body is required. Explain what changed and why in concrete terms: motivation, notable decisions, tradeoffs, migration notes. Base every claim on the supplied diff and context. Never invent facts.
- Use imperative mood: "add", "fix", "remove". Not "added", "fixes".
- Add "BREAKING CHANGE:" as a footer, or "!" after the type, when the change breaks compatibility.
- Match the repository's recent commit style when it is consistent.
- Output only the commit message, nothing else.`;

let cachedRuntime;
function resourceLoader() {
  if (!cachedRuntime) cachedRuntime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: cachedRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function askModel(model, prompt, cwd, signal) {
  let session;
  try {
    ({ session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: THINKING_LEVEL,
      resourceLoader: resourceLoader(),
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      tools: [],
    }));
  } catch (error) {
    throw new Error(`message model unavailable: ${error?.message ?? error}`);
  }

  const output = [];
  const unsubscribe = session.subscribe((event) => {
    if (event?.type !== "message_end" || event?.message?.role !== "assistant") return;
    for (const part of event.message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") output.push(part.text);
    }
  });
  const onAbort = () => void session.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const pending = session.prompt(prompt);
    if (signal?.aborted) onAbort();
    await pending;
    if (signal?.aborted) throw new Error("aborted");
    return output.join("\n\n").trim();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}

function stripFences(text) {
  const lines = text.split("\n");
  if (lines.length >= 2 && lines[0].trim().startsWith("```") && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return text;
}

function trim(text) {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function byteLength(text) {
  return Buffer.byteLength(text);
}

function byteSlice(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  while (limit > 0 && (bytes[limit] & 0xc0) === 0x80) limit--;
  return bytes.subarray(0, limit).toString();
}

function byteTail(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString();
}

async function runGit(pi, root, args, signal, stdoutLimit = MAX_GIT_OUT) {
  const result = await pi.exec("git", ["-C", root, ...args], { signal, timeout: TIMEOUT_MS });
  if (result.killed) throw new Error("git: killed (aborted or timed out)");
  if (byteLength(result.stdout) > stdoutLimit || byteLength(result.stderr) > 16 * 1024) {
    return { ok: false, stdout: "", stderr: "git output exceeded limit" };
  }
  return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

async function gitRoot(pi, cwd, signal) {
  const result = await runGit(pi, cwd, ["rev-parse", "--show-toplevel"], signal, 4096);
  return result.ok ? trim(result.stdout) : null;
}

function topLanguages(names) {
  const counts = new Map();
  for (const line of names.split("\n")) {
    const tab = line.lastIndexOf("\t");
    if (tab < 0) continue;
    const file = line.slice(tab + 1);
    const dot = file.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = file.slice(dot + 1).toLowerCase();
    if (!ext || byteLength(ext) > 12) continue;
    if (counts.has(ext)) counts.set(ext, counts.get(ext) + 1);
    else if (counts.size < 64) counts.set(ext, 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ext]) => ext).join(", ");
}

const NOISE_PREFIXES = [
  "//", "#", "/*", "*", "<!--", "import ", "from ", "use ", "require(",
  "export {", "export default", "package ", "end", "});", "});;",
];
const DECL_PREFIXES = [
  "pub ", "export ", "def ", "func ", "fn ", "function ", "class ", "struct ",
  "enum ", "interface ", "trait ", "impl ", "type ", "const ", "let ", "var ",
  "async ", "static ", "private ", "public ", "protected ", "internal ", "final ", "abstract ",
  "override ", "@", "case ", "goto ", "return ", "throw ", "if ", "for ",
  "while ", "switch ", "catch ", "void ", "int ", "bool ", "string ", "float ",
  "double ", "char ", "do ", "else ", "new ", "try ", "yield ", "await ",
  "require(", "import(", "module.exports",
];

function isNoiseLine(line) {
  const value = line.replace(/^[ \t]+|[ \t]+$/g, "");
  if (byteLength(value) < 4 || byteLength(value) > 120) return true;
  if (!/[A-Za-z0-9]/.test(value)) return true;
  return NOISE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function buildDigest(raw) {
  let out = "";
  const sections = raw.split("diff --git ").slice(1);
  for (const section of sections) {
    if (byteLength(out) >= DIGEST_LIMIT) break;
    const lines = section.split("\n");
    const head = lines.shift();
    if (!head) continue;
    let filePath = head.slice(head.lastIndexOf(" ") + 1);
    if (filePath.startsWith("b/")) filePath = filePath.slice(2);

    let file = "";
    let hunks = 0;
    let includeHunk = false;
    let interesting = 0;
    let declarations = 0;
    for (const line of lines) {
      if (byteLength(out) + byteLength(file) >= DIGEST_LIMIT) break;
      if (line.startsWith("@@")) {
        includeHunk = hunks < 8;
        if (!includeHunk) continue;
        hunks++;
        file += `  ${line}\n`;
        continue;
      }
      if (!includeHunk || !line || (line[0] !== "+" && line[0] !== "-") || line.startsWith("+++") || line.startsWith("---")) continue;
      const content = line.slice(1);
      const classified = content.trimStart();
      if (isNoiseLine(content) || interesting >= 14) continue;
      if (DECL_PREFIXES.some((prefix) => classified.startsWith(prefix)) && declarations < 10) {
        declarations++;
        interesting++;
        file += `  ${line}\n`;
      } else if (declarations >= 10 && interesting - declarations < 4) {
        interesting++;
        file += `  ${line}\n`;
      }
    }
    if (file) out += `### ${filePath}\n${file}`;
  }
  return out || byteSlice(raw, DIGEST_LIMIT);
}

function commitGuidance(root) {
  let out = "";
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    if (byteLength(out) >= 2048) break;
    let content;
    try {
      const data = readFileSync(path.join(root, name));
      if (data.length > 64 * 1024) continue;
      content = data.toString();
    } catch {
      continue;
    }
    let pending = 0;
    for (const line of content.split("\n")) {
      const value = trim(line);
      if (line.toLowerCase().includes("commit")) {
        out += `- ${value}\n`;
        pending = 2;
      } else if (pending > 0 && value) {
        out += `  ${value}\n`;
        pending--;
      }
      if (byteLength(out) >= 2048) break;
    }
  }
  return out;
}

async function analyze(pi, cwd, signal) {
  const root = await gitRoot(pi, cwd, signal);
  if (!root) throw new Error("not a git repository");

  for (const name of ["goal.md", "handoff.md"]) {
    try {
      statSync(path.join(root, name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`${name} still exists; remove it before committing`);
  }

  const add = await runGit(pi, root, ["add", "-A"], signal, 4096);
  if (!add.ok) throw new Error("git add failed");
  const initialTree = await runGit(pi, root, ["write-tree"], signal, 128);
  if (!initialTree.ok) throw new Error("git write-tree failed");
  const tree = trim(initialTree.stdout);
  const files = await runGit(pi, root, ["diff", "--cached", "-M", "--name-status"], signal, 64 * 1024);
  if (!files.ok) throw new Error("git diff --name-status failed");
  const names = trim(files.stdout);
  if (!names) return "";

  const stat = await runGit(pi, root, ["diff", "--cached", "-M", "--stat"], signal, 64 * 1024);
  const diff = await runGit(pi, root, ["diff", "--cached", "-M", "-U3"], signal);
  const style = await runGit(pi, root, ["log", "--pretty=format:%s", "-25"], signal, 8 * 1024);
  if (!stat.ok || !diff.ok) throw new Error("git diff failed");
  const finalTree = await runGit(pi, root, ["write-tree"], signal, 128);
  if (!finalTree.ok || trim(finalTree.stdout) !== tree) throw new Error("staged changes changed during analysis; run /commit again");

  let context = `## Repository\n${path.basename(root)}\n\n`;
  const languages = topLanguages(names);
  if (languages) context += `## Primary languages\n${languages}\n\n`;
  context += "## Changed files\n";
  for (const line of names.split("\n")) {
    if (line) context += `${line.replaceAll("\t", " ")}\n`;
  }
  if (stat.ok && trim(stat.stdout)) context += `\n## Diff stat\n${stat.stdout}\n`;
  const raw = diff.stdout.replace(/^\n+|\n+$/g, "");
  context += `\n## Diff\n${byteLength(raw) <= RAW_DIFF_LIMIT ? raw : buildDigest(raw)}\n`;
  const subjects = trim(style.stdout);
  if (style.ok && subjects) context += `\n## Recent commit style (last 25 subjects)\n${subjects}\n`;
  const guidance = commitGuidance(root);
  if (guidance) context += `\n## Repository commit guidance (AGENTS.md)\n${guidance}\n`;
  return { context: byteSlice(context, CONTEXT_LIMIT), tree };
}

function isVagueDescription(description) {
  const words = description.split(/[ \t]+/).filter(Boolean);
  if (!["update", "change", "changes", "misc", "stuff", "things", "various"].includes(words[0])) return false;
  return words.slice(1).every((word) => ["files", "file", "things", "thing", "stuff", "changes", "change", "various"].includes(word));
}

function isDiffNoiseLine(line) {
  const value = trim(line);
  return value.startsWith("diff --git ") || value.startsWith("@@") ||
    (value.startsWith("index ") && value.includes("..")) || value.startsWith("+++ ") || value.startsWith("--- ");
}

function validate(message) {
  const problems = [];
  const problem = (text) => problems.push(`- ${text}\n`);
  const value = trim(message);
  if (byteLength(value) < 8) problem("message is too short");

  const lines = value.split("\n");
  const header = lines.shift() ?? "";
  let bodyLength = 0;
  let diffNoise = false;
  const body = [];
  for (const line of lines) {
    if (isDiffNoiseLine(line)) diffNoise = true;
    const part = trim(line);
    bodyLength += byteLength(part);
    body.push(part);
  }
  const bodyText = trim(body.join("\n"));

  if (byteLength(header) > 100) problem("header is longer than 100 characters");
  let index = 0;
  while (index < header.length && header[index] >= "a" && header[index] <= "z") index++;
  const type = header.slice(0, index);
  if (!TYPES.has(type)) problem("type must be one of: feat, fix, docs, refactor, test, perf, ci, chore, build, style, revert");

  let rest = header.slice(index);
  let scopeOk = true;
  if (rest.startsWith("(")) {
    const found = rest.indexOf(")");
    const close = found < 0 ? 0 : found;
    if (close < 2) {
      scopeOk = false;
    } else {
      const scope = rest.slice(1, close);
      if (scope.includes("(") || scope.includes(")")) scopeOk = false;
      rest = rest.slice(close + 1);
    }
  }
  if (rest.startsWith("!")) rest = rest.slice(1);
  if (!rest || rest[0] !== ":") {
    problem("header must be <type>(<scope>): <description>");
  } else {
    rest = rest.slice(1).replace(/^[ \t]+|[ \t]+$/g, "");
    if (byteLength(rest) < 3) problem("description is too short");
    else if (isVagueDescription(rest)) problem("description is vague (for example \"update files\"); say what actually changed");
  }
  if (!scopeOk) problem("malformed scope in header");

  const placeholders = ["n/a", "na", "none", "no body", "see header", "see above", "tbd", "todo"];
  if (diffNoise) problem("message contains diff output, not commit text");
  if (placeholders.some((placeholder) => bodyText.toLowerCase() === placeholder)) {
    problem("body is a placeholder; write what changed and why");
  } else if (bodyLength < 50) {
    problem("body is missing or too thin: explain what changed and why (motivation, decisions, tradeoffs)");
  }
  return problems.join("");
}

function commitWithInput(root, message, signal) {
  return new Promise<any>((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", ["-C", root, "commit", "-F", "-"], {
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let killed = false;
    let forceTimer;
    const sendSignal = (value) => {
      try {
        if (detached) process.kill(-child.pid, value);
        else child.kill(value);
      } catch {
        // process already exited
      }
    };
    const kill = () => {
      if (killed) return;
      killed = true;
      sendSignal("SIGTERM");
      forceTimer = setTimeout(() => sendSignal("SIGKILL"), 5000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", kill);
    };
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk) => {
      const remaining = MAX_GIT_OUT - stdoutLength;
      if (remaining <= 0) return;
      const bytes = Buffer.from(chunk);
      stdout.push(bytes.subarray(0, remaining));
      stdoutLength += Math.min(bytes.length, remaining);
    });
    child.stderr.on("data", (chunk) => {
      const remaining = 16 * 1024 - stderrLength;
      if (remaining <= 0) return;
      const bytes = Buffer.from(chunk);
      stderr.push(bytes.subarray(0, remaining));
      stderrLength += Math.min(bytes.length, remaining);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (killed) return reject(new Error("git: killed (aborted or timed out)"));
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(stdout, stdoutLength).toString(),
        stderr: Buffer.concat(stderr, stderrLength).toString(),
      });
    });
    child.stdin.end(`${message.replace(/\n+$/g, "")}\n`);
    if (signal?.aborted) kill();
  });
}

async function commit(pi, cwd, message, signal, expectedTree) {
  const root = await gitRoot(pi, cwd, signal);
  if (!root) throw new Error("not a git repository");
  const staged = await runGit(pi, root, ["diff", "--cached", "--name-status"], signal, 64 * 1024);
  if (!staged.ok || !trim(staged.stdout)) throw new Error("nothing is staged; run /commit again so the working tree is re-snapshotted");
  const tree = await runGit(pi, root, ["write-tree"], signal, 128);
  if (!tree.ok || trim(tree.stdout) !== expectedTree) throw new Error("staged changes changed while writing the message; run /commit again");
  const result = await commitWithInput(root, trim(message), signal);
  if (!result.ok) throw new Error(trim(result.stderr) || "git commit failed");
  const hashResult = await runGit(pi, root, ["rev-parse", "--short", "HEAD"], signal, 64);
  if (!hashResult.ok) throw new Error("commit created but hash lookup failed");
  return `${trim(hashResult.stdout)} ${trim(message.split("\n")[0] ?? message)}`;
}

function buildPrompt(context, intent, tail) {
  const prefix = "Write ONE conventional commit message for the changes below.\n\n## Diff context\n";
  const suffix = [];
  if (intent) suffix.push("", "User intent (use only when supported by the diff):", byteSlice(intent, MAX_INTENT));
  if (tail) suffix.push("", "Recent session context (intent only; the diff stays the source of truth):", tail);
  const rest = suffix.join("\n");
  const contextLimit = Math.max(0, CONTEXT_LIMIT - byteLength(prefix) - byteLength(rest));
  return byteSlice(`${prefix}${byteSlice(context, contextLimit)}${rest}`, CONTEXT_LIMIT);
}

function sessionTail(ctx) {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const lines = [];
    for (const entry of entries.slice(-12)) {
      if (entry?.type !== "message") continue;
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = entry.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) text = content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
      if (text.trim()) lines.push(`[${role}] ${text.trim()}`);
    }
    return byteTail(lines.join("\n"), MAX_SESSION_TAIL);
  } catch {
    return "";
  }
}

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[commit] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("commit", {
    description: "Stage all changes and commit them with an AI-generated conventional message",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      showSpinner(ctx, "analyzing changes");
      try {
        const analysis = await analyze(pi, cwd, ctx.signal);
        if (!analysis) return notify(ctx, "nothing to commit", "info");

        const model = ctx.model;
        if (!model) return notify(ctx, "no model available", "error");
        const prompt = buildPrompt(analysis.context, (args ?? "").trim(), sessionTail(ctx));

        showSpinner(ctx, "writing commit message");
        let message = stripFences(await askModel(model, prompt, cwd, ctx.signal));
        let problems = validate(message);
        if (problems) {
          const correction = `\n\nYour previous message was rejected:\n${problems}Return only a corrected conventional commit message.`;
          const retryPrompt = `${byteSlice(prompt, CONTEXT_LIMIT - byteLength(correction))}${correction}`;
          const retry = stripFences(await askModel(model, retryPrompt, cwd, ctx.signal));
          problems = validate(retry);
          if (problems) return notify(ctx, `message rejected after retry:\n${problems}Last attempt:\n${retry}`, "error");
          message = retry;
        }

        showSpinner(ctx, "creating commit");
        notify(ctx, await commit(pi, cwd, message, ctx.signal, analysis.tree), "success");
      } catch (error) {
        notify(ctx, error?.message ?? String(error), "error");
      } finally {
        hideSpinner(ctx);
      }
    },
  });
}
