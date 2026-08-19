// pi-commit: /commit command glue for the Zig commit backend.
// Inspired by tmonk/pi-committer (https://github.com/tmonk/pi-committer), adapted
// to a Zig backend for git logic and message validation.
//
// Thin TS: registers the /commit command, bridges to the Zig backend
// (src/commit.zig) as a one-shot process: each op travels as one JSON argv
// element via pi.exec (shared callZig helper), the binary prints one JSON
// envelope to stdout and exits. The glue calls the current model through the
// pi SDK for commit-message generation and lets the backend create the
// commit. All git logic lives in Zig.
//
// Protocol:
//   pi.exec("pi-commit", ['{"op":"analyze","cwd":"..."}'])        -> {"ok":true,"result":"<context>"}
//   pi.exec("pi-commit", ['{"op":"analyze","cwd":"..."}'])        -> {"ok":true,"result":""}  nothing staged
//   pi.exec("pi-commit", ['{"op":"validate","message":"..."}'])   -> {"ok":true,"result":"ok"} | {"ok":false,"error":"- problem..."}
//   pi.exec("pi-commit", ['{"op":"commit","message":"..."}'])     -> {"ok":true,"result":"<hash> <header>"}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { callZig } from "./lib/zig";

// Animated spinner shown as a widget above the editor while the commit
// pipeline runs (TUI mode only: RPC mode ignores component factories, print
// mode has no widgets, so the interval never exists there). The widget is
// disposed on removal and on TUI teardown, which clears the interval.
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
const TIMEOUT_MS = 60000; // per git op cap; Esc aborts the process regardless

// System prompt for the message-generation subagent. The rules mirror what
// the Zig validator enforces; the model writes, the backend judges.
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

// ----- message generation via the pi SDK (same pattern pi-committer uses) -----

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

// Model objects come from pi's runtime; copy the plain fields so the SDK
// session gets a clean value.
function serializableModel(model) {
  if (!model || typeof model !== "object") return undefined;
  const copy: Record<string, any> = {};
  for (const key of [
    "provider", "id", "name", "api", "baseUrl", "reasoning",
    "input", "cost", "contextWindow", "maxTokens",
  ]) {
    const value = model[key];
    if (value !== undefined && typeof value !== "function") copy[key] = value;
  }
  return copy.provider && copy.id ? copy : undefined;
}

async function askModel(model, prompt, cwd) {
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
  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe();
    session.dispose();
  }
  return output.join("\n\n").trim();
}

// Models sometimes wrap the message in a markdown code fence; strip it.
function stripFences(text) {
  const lines = text.split("\n");
  if (lines.length >= 2 && lines[0].trim().startsWith("```") && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return text;
}

async function validate(pi, message) {
  try {
    await callZig(pi, "pi-commit", { op: "validate", message });
    return null; // valid
  } catch (err) {
    return err?.message ?? String(err); // "- problem" lines
  }
}

function buildPrompt(context, intent, sessionTail) {
  const parts = ["Write ONE conventional commit message for the changes below.", "", "## Diff context", context];
  if (intent) parts.push("", "User intent (use only when supported by the diff):", intent);
  if (sessionTail) parts.push("", "Recent session context (intent only; the diff stays the source of truth):", sessionTail);
  return parts.join("\n");
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
      else if (Array.isArray(content)) {
        text = content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
      }
      if (text.trim()) lines.push(`[${role}] ${text.trim()}`);
    }
    return lines.join("\n").slice(-MAX_SESSION_TAIL);
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
        const analyze = await callZig(pi, "pi-commit", { op: "analyze", cwd }, { signal: ctx.signal, timeout: TIMEOUT_MS });
        if (analyze.result === "") return notify(ctx, "nothing to commit", "info");

        const model = serializableModel(ctx.model);
        if (!model) return notify(ctx, "no model available", "error");

        const intent = (args ?? "").trim();
        const prompt = buildPrompt(analyze.result, intent, sessionTail(ctx));

        showSpinner(ctx, "writing commit message");
        let message = stripFences(await askModel(model, prompt, cwd));
        let problems = await validate(pi, message);
        if (problems) {
          const retryPrompt = `${prompt}\n\nYour previous message was rejected:\n${problems}Return only a corrected conventional commit message.`;
          const retry = stripFences(await askModel(model, retryPrompt, cwd));
          problems = await validate(pi, retry);
          if (problems) {
            return notify(ctx, `message rejected after retry:\n${problems}Last attempt:\n${retry}`, "error");
          }
          message = retry;
        }

        showSpinner(ctx, "creating commit");
        const result = await callZig(pi, "pi-commit", { op: "commit", message, cwd }, { signal: ctx.signal, timeout: TIMEOUT_MS });
        notify(ctx, result.result, "success");
      } catch (err) {
        notify(ctx, err?.message ?? String(err), "error");
      } finally {
        hideSpinner(ctx);
      }
    },
  });
}
