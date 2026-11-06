// pi-commit: shared commit command and tool workflow.
// Inspired by tmonk/pi-committer (https://github.com/tmonk/pi-committer).

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, createExtensionRuntime, getAgentDir, SessionManager, SettingsManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { modelKey, registerWorkerModel } from "./lib/worker-model";
import { registerRemoteCommand } from "./lib/remote-command";

interface CommitDisplay {
  step: (label: string) => void;
  message: (text: string) => void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_WIDGET = "commit";

function duration(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function showSpinner(ctx, label, started) {
  try {
    ctx.ui.setWidget(SPINNER_WIDGET, (tui, theme) => {
      const text = new Text(theme.fg("dim", `${SPINNER_FRAMES[0]} ${label} · ${duration(performance.now() - started)}`), 1, 0);
      let frame = 0;
      const timer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        text.setText(theme.fg("dim", `${SPINNER_FRAMES[frame]} ${label} · ${duration(performance.now() - started)}`));
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

const timingPath = () => path.join(getAgentDir(), "commit-timing.json");

async function readTiming() {
  const file = timingPath();
  if (!existsSync(file)) return "normal";
  const mode = JSON.parse(await readFile(file, "utf8")).mode;
  if (mode !== "normal" && mode !== "verbose") throw new Error("Invalid commit timing setting. Use /commit-timing normal or verbose");
  return mode;
}

function trackTiming(ctx, display?: CommitDisplay) {
  let mode = "normal";
  const started = performance.now();
  const parts = [];
  let current;
  let phase;
  const finish = (entry, now) => {
    if (entry) parts.push(`${entry.label}: ${duration(now - entry.started)}`);
  };
  return {
    setMode(value) { mode = value; },
    step(label) {
      const now = performance.now();
      const nextPhase = label.startsWith("push:") ? "Push"
        : label.startsWith("commit:") ? "Create commit"
        : label.startsWith("first attempt:") || label.startsWith("retry:") || label.startsWith("validate") ? "Write message"
        : "Analyze";
      if (mode === "verbose") {
        finish(current, now);
        current = { label, started: now };
        if (display) display.step(label);
        else showSpinner(ctx, label, now);
      } else if (!phase || phase.label !== nextPhase) {
        finish(phase, now);
        phase = { label: nextPhase, started: now };
        if (display) display.step(nextPhase);
        else showSpinner(ctx, nextPhase, now);
      }
    },
    finish() {
      const now = performance.now();
      finish(mode === "verbose" ? current : phase, now);
      const text = `Timing (total ${duration(now - started)}):\n${parts.join("\n")}`;
      if (display) display.message(text);
      else {
        hideSpinner(ctx);
        notify(ctx, text);
      }
    },
  };
}

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
- Follow repository commit guidance for additional rules, but always keep the Conventional Commit format and required body.
- An explicit required ticket prefix takes priority over repository guidance and session context. Put it before the type, separated by one space, for example "CAS-1234 fix: handle expired sessions".
- Without an explicit prefix, add a ticket prefix only when repository guidance requires it and the current branch or session clearly identifies the current ticket. Ticket IDs use uppercase letters or digits followed by a hyphen and digits. Never invent a ticket or use an example ticket as the current ticket.
- Output only the commit message, nothing else.`;

const SPLIT_PROMPT = `Plan ordered logical Conventional Commits from the complete repository change set.
Return only a JSON array of objects: [{"intent":"specific purpose and motivation","files":[1,2]}].
Use the numbered file units supplied by the caller, not path strings. Cover every unit exactly once.
Each group must contain at least one whole-file unit. Rename source and destination are one unit.
Keep related implementation, tests, documentation, and generated files together. Order dependencies first.
Do not split changes within a file. Use one group when the changes form one logical commit.
Preserve the user's intent and required ticket prefix across the sequence. Never invent changes.`;

let cachedRuntime;
function resourceLoader(systemPrompt = SYSTEM_PROMPT) {
  if (!cachedRuntime) cachedRuntime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: cachedRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function askModel(model, thinkingLevel, prompt, cwd, signal, step, attempt, systemPrompt = SYSTEM_PROMPT) {
  step(`${attempt}: model session setup`);
  let session;
  try {
    ({ session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel,
      resourceLoader: resourceLoader(systemPrompt),
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
    signal?.throwIfAborted();
    step(`${attempt}: message generation`);
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

async function analyze(pi, cwd, signal, step, stageAll = true) {
  step("analysis: repository lookup");
  const root = await gitRoot(pi, cwd, signal);
  if (!root) throw new Error("not a git repository");

  step("analysis: check blocking files");
  for (const name of ["goal.md", "handoff.md"]) {
    try {
      statSync(path.join(root, name));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`${name} still exists; remove it before committing`);
  }

  if (stageAll) {
    step("analysis: git add -A");
    const add = await runGit(pi, root, ["add", "-A"], signal, 4096);
    if (!add.ok) throw new Error("git add failed");
  }
  step("analysis: initial git write-tree");
  const initialTree = await runGit(pi, root, ["write-tree"], signal, 128);
  if (!initialTree.ok) throw new Error("git write-tree failed");
  const tree = trim(initialTree.stdout);
  step("analysis: git diff --name-status");
  const files = await runGit(pi, root, ["diff", "--cached", "-M", "--name-status"], signal, 64 * 1024);
  if (!files.ok) throw new Error("git diff --name-status failed");
  const names = trim(files.stdout);
  if (!names) return null;

  step("analysis: git diff --stat");
  const stat = await runGit(pi, root, ["diff", "--cached", "-M", "--stat"], signal, 64 * 1024);
  step("analysis: git diff -U3");
  const diff = await runGit(pi, root, ["diff", "--cached", "-M", "-U3"], signal);
  step("analysis: branch lookup");
  const branch = await runGit(pi, root, ["rev-parse", "--abbrev-ref", "HEAD"], signal, 4096);
  if (!stat.ok || !diff.ok) throw new Error("git diff failed");
  step("analysis: final git write-tree");
  const finalTree = await runGit(pi, root, ["write-tree"], signal, 128);
  if (!finalTree.ok || trim(finalTree.stdout) !== tree) throw new Error("staged changes changed during analysis; run /commit again");

  step("analysis: build diff context and read guidance");
  let context = `## Repository\n${path.basename(root)}\n\n`;
  if (branch.ok) context += `## Current branch\n${trim(branch.stdout)}\n\n`;
  const guidance = commitGuidance(root);
  if (guidance) context += `## Repository commit guidance (AGENTS.md / CLAUDE.md)\n${guidance}\n`;
  const languages = topLanguages(names);
  if (languages) context += `## Primary languages\n${languages}\n\n`;
  context += "## Changed files\n";
  for (const line of names.split("\n")) {
    if (line) context += `${line.replaceAll("\t", " ")}\n`;
  }
  if (stat.ok && trim(stat.stdout)) context += `\n## Diff stat\n${stat.stdout}\n`;
  const raw = diff.stdout.replace(/^\n+|\n+$/g, "");
  const fullContext = `${context}\n## Diff\n${raw}\n`;
  context += `\n## Diff\n${byteLength(raw) <= RAW_DIFF_LIMIT ? raw : buildDigest(raw)}\n`;
  return { context: byteSlice(context, CONTEXT_LIMIT), fullContext, tree, root };
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

function validate(message, requiredPrefix) {
  const problems = [];
  const problem = (text) => problems.push(`- ${text}\n`);
  const value = trim(message);
  if (byteLength(value) < 8) problem("message is too short");

  const lines = value.split("\n");
  let header = lines.shift() ?? "";
  if (byteLength(header) > 100) problem("header is longer than 100 characters");
  if (requiredPrefix && !header.startsWith(`${requiredPrefix} `)) {
    problem(`header must start with the exact ticket prefix "${requiredPrefix} "`);
  }
  header = header.replace(/^[A-Z][A-Z0-9]*-\d+ /, "");
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

async function commit(pi, cwd, message, signal, expectedTree, step) {
  step("commit: repository lookup");
  const root = await gitRoot(pi, cwd, signal);
  if (!root) throw new Error("not a git repository");
  step("commit: check staged files");
  const staged = await runGit(pi, root, ["diff", "--cached", "--name-status"], signal, 64 * 1024);
  if (!staged.ok || !trim(staged.stdout)) throw new Error("nothing is staged; run /commit again so the working tree is re-snapshotted");
  step("commit: verify staged tree");
  const tree = await runGit(pi, root, ["write-tree"], signal, 128);
  if (!tree.ok || trim(tree.stdout) !== expectedTree) throw new Error("staged changes changed while writing the message; run /commit again");
  step("commit: git commit (includes hooks and signing)");
  const result = await commitWithInput(root, trim(message), signal);
  if (!result.ok) throw new Error(trim(result.stderr) || "git commit failed");
  step("commit: hash lookup");
  const hashResult = await runGit(pi, root, ["rev-parse", "--short", "HEAD"], signal, 64);
  if (!hashResult.ok) throw new Error("commit created but hash lookup failed");
  return `${trim(hashResult.stdout)} ${trim(message.split("\n")[0] ?? message)}`;
}

function buildPrompt(context, intent, tail, requiredPrefix) {
  const prefix = "Write ONE conventional commit message for the changes below.\n\n## Diff context\n";
  const suffix = [];
  if (requiredPrefix) suffix.push("", `Required ticket prefix (exact, before the conventional type): ${requiredPrefix}`);
  if (intent) suffix.push("", "User intent (use only when supported by the diff):", byteSlice(intent, MAX_INTENT));
  if (tail) suffix.push("", "Recent session context (intent only; the diff stays the source of truth):", tail);
  const rest = suffix.join("\n");
  const contextLimit = Math.max(0, CONTEXT_LIMIT - byteLength(prefix) - byteLength(rest));
  return byteSlice(`${prefix}${byteSlice(context, contextLimit)}${rest}`, CONTEXT_LIMIT);
}

async function planSplit(pi, analysis, model, thinkingLevel, intent, tail, requiredPrefix, signal, step) {
  step("plan: collect whole-file units");
  const result = await runGit(pi, analysis.root, ["diff", "--cached", "-M", "--name-status", "-z"], signal);
  if (!result.ok) throw new Error("git diff --name-status failed");
  const fields = result.stdout.split("\0").slice(0, -1);
  const units = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const paths = [fields[i++]];
    if (status.startsWith("R") || status.startsWith("C")) paths.push(fields[i++]);
    units.push({ status, paths });
  }
  const prompt = [
    `## Whole-file units\n${units.map((unit, i) => JSON.stringify({ id: i + 1, ...unit })).join("\n")}`,
    `## Required ticket prefix\n${requiredPrefix || "None explicitly requested"}`,
    `## User intent\n${intent}`,
    `## Recent session context (intent only)\n${tail}`,
    analysis.fullContext,
  ].join("\n\n");
  const output = await askModel(model, thinkingLevel, prompt, analysis.root, signal, step, "plan", SPLIT_PROMPT);
  const groups = JSON.parse(stripFences(output));
  if (!Array.isArray(groups) || !groups.length) throw new Error("split plan must be a nonempty JSON array");
  const seen = new Set();
  const plan = groups.map((group) => {
    if (!group || typeof group.intent !== "string" || !group.intent.trim() || !Array.isArray(group.files) || !group.files.length) {
      throw new Error("each split group must have an intent and nonempty files array");
    }
    const paths = group.files.flatMap((id) => {
      if (!Number.isInteger(id) || id < 1 || id > units.length || seen.has(id)) {
        throw new Error(`split plan has an invalid or repeated file unit: ${id}`);
      }
      seen.add(id);
      return units[id - 1].paths;
    });
    return { intent: group.intent.trim(), paths };
  });
  if (seen.size !== units.length) throw new Error("split plan does not cover every changed file");
  step("plan: verify complete snapshot");
  const tree = await runGit(pi, analysis.root, ["write-tree"], signal, 128);
  const worktree = await runGit(pi, analysis.root, ["diff", "--quiet"], signal, 4096);
  if (!tree.ok || trim(tree.stdout) !== analysis.tree || !worktree.ok) {
    throw new Error("changes changed during split planning; run /commit --split again");
  }
  return plan;
}

async function checkSplitProgress(pi, root, group, remaining, signal, step) {
  step("commit: verify hook scope and remaining work");
  const changed = await runGit(pi, root, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", "HEAD"], signal);
  if (!changed.ok) throw new Error("cannot verify committed files");
  const files = changed.stdout.split("\0").filter(Boolean);
  const expected = new Set(group.paths);
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) {
    throw new Error("a commit hook changed the planned file scope; inspect the completed commit before continuing");
  }
  const status = await runGit(pi, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
  if (!status.ok) throw new Error("cannot check remaining work");
  const allowed = new Set(remaining.flatMap((item) => item.paths));
  const entries = status.stdout.split("\0").slice(0, -1);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const paths = [entry.slice(3)];
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(entries[++i]);
    if ((entry[0] !== " " && entry.slice(0, 2) !== "??") || paths.some((file) => !allowed.has(file))) {
      throw new Error("hooks or other work left staged changes or changes outside the remaining split plan; inspect git status before continuing");
    }
  }
}

function sessionTail(ctx) {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const lines = [];
    const messages = entries.filter((entry) =>
      entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
    );
    for (const entry of messages.slice(-12)) {
      const role = entry.message.role;
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

async function writeMessage(model, thinkingLevel, prompt, cwd, signal, step, requiredPrefix) {
  let message = stripFences(await askModel(model, thinkingLevel, prompt, cwd, signal, step, "first attempt"));
  step("validate message");
  let problems = validate(message, requiredPrefix);
  if (problems) {
    const correction = `\n\nYour previous message was rejected:\n${problems}Return only a corrected conventional commit message.`;
    const retryPrompt = `${byteSlice(prompt, CONTEXT_LIMIT - byteLength(correction))}${correction}`;
    const retry = stripFences(await askModel(model, thinkingLevel, retryPrompt, cwd, signal, step, "retry"));
    step("validate retry");
    problems = validate(retry, requiredPrefix);
    if (problems) throw new Error(`message rejected after retry:\n${problems}Last attempt:\n${retry}`);
    message = retry;
  }
  return message;
}

export default function (pi: ExtensionAPI) {
  async function runCommit(args, ctx: ExtensionContext, signal, push = false, split = false, display?: CommitDisplay, directory?: string) {
    const cwd = directory === undefined ? ctx.cwd : path.resolve(ctx.cwd, directory);
    const timing = trackTiming(ctx, display);
    const report = (text, level = "info") => display ? display.message(text) : notify(ctx, text, level);
    const { step } = timing;
    let root;
    let base;
    let plan;
    let nextGroup = 0;
    let pushStarted = false;
    const completed = [];
    try {
      timing.setMode(await readTiming());
      step("load settings and select model");
      const config = await readConfig();
      const model = config
        ? ctx.modelRegistry.getAvailable().find((candidate) => modelKey(candidate) === config.model)
        : ctx.model;
      if (!model) throw new Error(config ? `Commit model unavailable: ${config.model}. Run /commit-model` : "no model available");
      const thinkingLevel = clampThinkingLevel(model, config?.thinking ?? "low");

      let analysis = await analyze(pi, cwd, signal, step);
      if (!analysis) {
        report("nothing to commit", "info");
        return "nothing to commit";
      }
      step("build prompt and session context");
      const input = (args ?? "").trim();
      const requiredPrefix = input.match(/^[A-Z][A-Z0-9]*-\d+(?=\s|$)/)?.[0] ?? "";
      const intent = input.slice(requiredPrefix.length).trim();
      const tail = sessionTail(ctx);
      if (split) {
        root = analysis.root;
        step("plan: record starting HEAD");
        base = await runGit(pi, root, ["rev-parse", "--verify", "HEAD"], signal, 128);
        plan = await planSplit(pi, analysis, model, thinkingLevel, intent, tail, requiredPrefix, signal, step);
        report(`Split plan (${plan.length} commits):\n${plan.map((group, i) => `${i + 1}. ${group.intent}\n${group.paths.map((file) => `  ${JSON.stringify(file)}`).join("\n")}`).join("\n")}`);
        step("plan: unstage complete snapshot (keep working files)");
        const reset = await runGit(pi, root, ["read-tree", ...(base.ok ? [trim(base.stdout)] : ["--empty"])], signal, 4096);
        if (!reset.ok) throw new Error(`cannot prepare split index: ${trim(reset.stderr)}`);
      }

      const groups = plan ?? [{ intent, paths: [] }];
      for (const group of groups) {
        if (split) {
          step(`analysis: stage split group ${nextGroup + 1}/${groups.length}`);
          const add = await runGit(pi, root, ["--literal-pathspecs", "add", "-A", "--", ...group.paths], signal, 4096);
          if (!add.ok) throw new Error(`cannot stage split group: ${trim(add.stderr)}`);
          analysis = await analyze(pi, root, signal, step, false);
          if (!analysis) throw new Error("split group has no remaining changes; inspect the completed commits and plan");
        }
        const groupIntent = split ? `${intent}\n\nSplit group ${nextGroup + 1}/${groups.length}: ${group.intent}` : intent;
        const prompt = buildPrompt(analysis.context, groupIntent, tail, requiredPrefix);
        const message = await writeMessage(model, thinkingLevel, prompt, cwd, signal, step, requiredPrefix);
        const summary = await commit(pi, cwd, message, signal, analysis.tree, step);
        completed.push(summary);
        report(summary, "success");
        nextGroup++;
        if (split) await checkSplitProgress(pi, root, group, groups.slice(nextGroup), signal, step);
      }

      const summary = completed.join("\n");
      if (push) {
        step("push: git push");
        pushStarted = true;
        const result = await runGit(pi, cwd, ["push"], signal);
        if (!result.ok) throw new Error(`commit created (${summary}), but git push failed: ${trim(result.stderr)}`);
        report("git push completed", "success");
      }
      return summary;
    } catch (error) {
      if (!split) throw error;
      // Read recovery state without the cancelled signal. Never change it or roll back.
      const history = base && await runGit(pi, root, ["log", "--reverse", "--format=%h %s", ...(base.ok ? [`${trim(base.stdout)}..HEAD`] : ["HEAD"])], undefined);
      const status = root && await runGit(pi, root, ["status", "--short", "--untracked-files=all"], undefined);
      const done = history?.ok ? trim(history.stdout) || "none" : completed.join("\n") || "none recorded (check git log)";
      const remaining = plan ? plan.slice(nextGroup).map((group) => `${group.intent}: ${group.paths.map((file) => JSON.stringify(file)).join(", ")}`).join("\n") || "no unattempted groups" : "not planned";
      throw new Error(`Split sequence stopped: ${error?.message ?? error}\nCompleted commits (retained):\n${done}\nRemaining plan:\n${remaining}\nRemaining work (git status):\n${status?.ok ? trim(status.stdout) || "clean" : "unavailable, inspect git status"}\n${pushStarted ? "Push was attempted only after all groups completed" : "No push was attempted"}. No rollback was made`);
    } finally {
      timing.finish();
    }
  }

  for (const command of ["commit", "commit-and-push"]) {
    const run = (args, ctx, display?: CommitDisplay, signal = ctx.signal) => {
      const split = /^--split(?:\s|$)/.test(args.trim());
      const intent = split ? args.trim().slice("--split".length).trim() : args;
      return runCommit(intent, ctx, signal, command === "commit-and-push", split, display);
    };
    registerRemoteCommand(pi, command, `Stage all changes and commit${command === "commit-and-push" ? ", then push" : ""}`, async (args, ctx, update, signal) => {
      const messages = [];
      try {
        await run(args, ctx, { step: update, message: (text) => messages.push(text) }, signal);
        return { text: messages.join("\n\n") };
      } catch (error) {
        return { text: [...messages, error.message].join("\n\n"), error: error.message };
      }
    });
    pi.registerCommand(command, {
      description: `Stage all changes and write Conventional Commits${command === "commit-and-push" ? ", then git push" : ""}: /${command} [--split] [CAS-1234] [intent] (one commit by default)`,
      handler: async (args, ctx) => {
        try {
          await run(args, ctx);
        } catch (error) {
          notify(ctx, error?.message ?? String(error), "error");
        }
      },
    });
  }

  const readConfig = registerWorkerModel(pi, "commit", "Commit");

  pi.registerTool({
    name: "commit",
    label: "Commit",
    description: "Stage all repository changes and create one Conventional Commit by default, or ordered logical whole-file commits with split: true, through the /commit workflow and its model/thinking settings. Only use when the user explicitly requests commits. Stops if root goal.md or handoff.md exists. Split failures retain completed commits and report remaining work. Never pushes",
    promptSnippet: "Create user-requested commits through the shared /commit workflow, with optional logical whole-file splitting",
    promptGuidelines: [
      "Only commit when the user explicitly requests it. After work and checks are complete, use the commit tool for requests such as 'do the work then commit', not bash or a separate git workflow. Never make unsolicited commits",
      "Pass commit's cwd parameter when the target repository is outside the session directory. Relative cwd paths resolve against the session directory. If commit fails, report the failure instead of bypassing the commit workflow with bash or another Git workflow",
      "The commit tool stages all repository changes, not a selected subset. Check the full change set first. If that scope conflicts with the user's request, ask the user rather than bypassing the workflow. Do not delete goal.md or handoff.md just to bypass the commit safeguard",
      "Use the commit tool with split: true when the user asks for logical multiple commits, separate commits, or splitting changes into commits. Do not use a separate bash workflow. Split covers all changed files exactly once in ordered whole-file groups and can select one group. It never stages part of a file. Stop on failure and report completed commits and remaining work, do not retry automatically or push a partial sequence",
      "Pass any requested ticket prefix and intent in commit's intent parameter, as with /commit [--split] [CAS-1234] [intent]. Set the split parameter separately, not in intent. The commit tool never pushes. If the user explicitly requests a push, use bash with git -C <target> push only after the full commit workflow succeeds, including all split groups and checks. Never push after failure or a partial sequence. /commit-and-push is a separate user command",
    ],
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Target repository directory, absolute or relative to the session directory. Defaults to the session directory" })),
      intent: Type.Optional(Type.String({ description: "Optional /commit arguments: a leading ticket ID such as CAS-1234, followed by message intent, applied to every commit" })),
      split: Type.Optional(Type.Boolean({ description: "Plan ordered logical whole-file commits from all changes. Default false creates one commit. One logical group is allowed" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const summary = await runCommit(params.intent, ctx, signal, false, params.split, undefined, params.cwd);
      return { content: [{ type: "text", text: summary }], details: undefined };
    },
  });

  pi.registerCommand("commit-timing", {
    description: "Select commit timing detail: /commit-timing [normal|verbose]",
    handler: async (args, ctx) => {
      let mode = args.trim();
      if (!mode) {
        if (ctx.mode !== "tui") throw new Error("Use /commit-timing normal or /commit-timing verbose outside the TUI");
        mode = await ctx.ui.select("Commit timing (saved for all sessions)", ["normal", "verbose"]);
        if (!mode) return;
      }
      if (mode !== "normal" && mode !== "verbose") throw new Error("Commit timing must be normal or verbose");
      await withFileMutationQueue(timingPath(), async () => {
        await mkdir(getAgentDir(), { recursive: true });
        await writeFile(timingPath(), `${JSON.stringify({ mode }, null, 2)}\n`);
      });
      ctx.ui.notify(`Commit timing: ${mode}`, "info");
    },
  });
}
