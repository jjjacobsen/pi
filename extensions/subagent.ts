// pi-subagent: delegate tasks to isolated in-process sub-sessions.
//
// The isolated worker is pi's own agent loop:
// every subagent tool call creates a second, fully isolated AgentSession via
// the SDK (createAgentSession) in this process, prompts it with the task,
// waits for it to finish, and returns only its final message as the tool
// result. The caller's session only ever contains the task string and the
// returned summary, so its context window stays small while the subagent
// does the heavy work.
//
// Design rules:
// - One AgentSession per tool call, fully independent. Pi executes sibling
//   tool calls from one assistant turn concurrently, so firing several
//   subagent calls in one turn runs several subagents in parallel.
// - The subagent gets the built-in tools (read, bash, edit, write) plus the
//   allowlisted search extension. The resource loader filters every other
//   extension out, so the subagent tool cannot recurse into itself and the
//   system prompt stays small. The tools allowlist is the second guard: even
//   if a filter leak slips an extension in, only the five names are callable.
// - Model and thinking use saved defaults, then inherit from the caller.
//   Optional per-call overrides take priority over those defaults.
// - The transcript is persisted under <agent_dir>/subagents/<ts>_<id>.jsonl
//   so any run can be resumed (SessionManager.open) or inspected.
// - The subagent's complete session usage rides back on the tool result's usage
//   field, so pi includes the spend in the caller's session totals.
// - Esc aborts the sub-session (signal -> session.abort()); progress
//   streams to the TUI via onUpdate.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clampThinkingLevel, getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai/compat";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerWorkerModel } from "./lib/worker-model";

const TOOL_NAME = "subagent";
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Extensions whose factories may run inside a sub-session. Exact paths avoid
// admitting an unrelated extension with the same filename.
const SUBAGENT_EXTENSIONS = new Set([fileURLToPath(new URL("search.ts", import.meta.url))]);

// The exact tools a subagent can call. The first four are built-ins, and the
// last one comes from the allowlisted extension above.
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "web_search"];

// Live stream display keeps only the trailing chars, so the TUI tool row
// stays cheap on long runs.
const STREAM_DISPLAY_CHARS = 4000;

const SUBAGENT_INSTRUCTIONS = `You are a subagent, spawned by the main pi session to complete one delegated task.

Rules:
- The task is self-contained. Work independently with your tools until it is done; do not ask the caller for clarification, instead make reasonable assumptions and note them in your report.
- Your final reply is returned verbatim to the calling agent. Write it as a standalone report: what you did, what changed or found, and any caveats or recommended follow-ups.
- End your reply with a short "Summary:" bullet section.`;

// Shared across subagent calls in this process: the model catalog + auth
// runtime, and the filtered resource loader (discovery runs once). A fresh
// pair is built when the extension reloads. cwd comes from the first call;
// pi's cwd is fixed per process, so it cannot drift.
let sharedPromise;

async function createShared(cwd: string) {
  const modelRuntime = await ModelRuntime.create();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((ext) => SUBAGENT_EXTENSIONS.has(ext.path)),
    }),
    systemPromptOverride: (base) => [base, SUBAGENT_INSTRUCTIONS].filter(Boolean).join("\n\n"),
  });
  await loader.reload();
  return { modelRuntime, loader };
}

function ensureShared(cwd: string) {
  return (sharedPromise ??= createShared(cwd));
}

function findExactModel(modelRuntime, reference) {
  const normalized = reference.trim().toLowerCase();
  const models = modelRuntime.getModels();
  const canonicalMatches = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
  if (canonicalMatches.length > 0) return canonicalMatches.length === 1 ? canonicalMatches[0] : undefined;

  const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

// Sum persisted usage, including tools, compaction, and cache warming.
function sumUsage(session) {
  let total;
  for (const entry of session.sessionManager.getEntries()) {
    let u;
    if (entry.type === "message") {
      if (entry.message.role === "assistant" || entry.message.role === "toolResult") u = entry.message.usage;
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      u = entry.usage;
    }
    if (!u) continue;
    total ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.totalTokens += u.totalTokens;
    if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + u.reasoning;
    if (u.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + u.cacheWrite1h;
    total.cost.input += u.cost.input;
    total.cost.output += u.cost.output;
    total.cost.cacheRead += u.cost.cacheRead;
    total.cost.cacheWrite += u.cost.cacheWrite;
    total.cost.total += u.cost.total;
  }
  return total;
}

function lastAssistantMessage(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message.role === "assistant") return message;
  }
}

function assistantText(message) {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function subagentExtension(pi: ExtensionAPI) {
  const readConfig = registerWorkerModel(pi, "subagent", "Subagent");

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent",
    description:
      "Delegate a self-contained task to an isolated subagent and get back only its final summary. The subagent runs with its own fresh context in the current project directory, with read, bash, edit, write, and web_search. It does not see this conversation. Model and reasoning overrides are optional; omit them to use saved /subagent-model and /subagent-thinking defaults, or inherit the parent session if unset. Use this for meaty but well-scoped work where you only need the outcome, not the intermediate steps: research, isolated refactors, digging through logs, writing reports. Call subagent once per independent task and several calls in parallel when tasks do not depend on each other. Do not delegate tiny tasks you can do yourself, and do not delegate tasks where you need to inspect the full intermediate output.",
    promptSnippet: "Delegate a self-contained task to an isolated subagent that returns only a summary",
    promptGuidelines: [
      "Use subagent when a task is meaty but self-contained and the caller only needs the outcome: research, isolated refactors, log digging, report writing. The subagent returns only its final message, so the caller's context stays small.",
      "Fire several subagent calls in the same turn to run independent tasks in parallel, one call per task.",
      "Omit subagent model and reasoning to use saved defaults, or inherit from the parent session if unset. Set only the value that needs an override.",
      "Do not delegate tiny tasks you can do yourself, and do not delegate tasks where you need to see the full intermediate output.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "The complete, self-contained task for the subagent: what to do, which files or paths matter, and what the final deliverable should look like. The subagent starts with a fresh context and works in the current project directory.",
      }),
      model: Type.Optional(
        Type.String({
          description: "Exact model as provider/model, or an unambiguous bare model ID. Omit to use the saved subagent model, or inherit the parent model if unset.",
        }),
      ),
      reasoning: Type.Optional(
        StringEnum(REASONING_LEVELS, {
          description: "Reasoning level for this subagent. Omit to use the saved subagent thinking level, or inherit the parent reasoning level if unset.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const config = await readConfig();
      const { modelRuntime, loader } = await ensureShared(ctx.cwd);
      const reference = params.model ?? config?.model;
      const model = reference ? findExactModel(modelRuntime, reference) : ctx.model;
      if (!model) {
        throw new Error(reference
          ? `subagent: model "${reference}" was not found or is ambiguous. Use an exact provider/model or run /subagent-model`
          : "subagent: no active model in this session");
      }

      const supportedReasoning = getSupportedThinkingLevels(model);
      if (params.reasoning && !supportedReasoning.includes(params.reasoning)) {
        throw new Error(
          `subagent: reasoning "${params.reasoning}" is not supported by ${model.provider}/${model.id} (supported: ${supportedReasoning.join(", ")})`,
        );
      }
      const thinkingLevel = params.reasoning ?? clampThinkingLevel(model, config?.thinking ?? ctx.thinkingLevel);

      const agentDir = getAgentDir();
      const parentSession = ctx.sessionManager.getSessionFile();
      const sessionManager = SessionManager.create(
        ctx.cwd,
        join(agentDir, "subagents"),
        parentSession ? { parentSession } : undefined,
      );
      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        agentDir,
        model,
        thinkingLevel,
        modelRuntime,
        resourceLoader: loader,
        sessionManager,
        settingsManager: SettingsManager.create(ctx.cwd, agentDir),
        tools: SUBAGENT_TOOLS,
      });

      // Stream the subagent's text into the TUI so the caller sees progress.
      let streamBuffer = "";
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_update") return;
        if (event.assistantMessageEvent.type !== "text_delta") return;
        streamBuffer += event.assistantMessageEvent.delta;
        if (streamBuffer.length > STREAM_DISPLAY_CHARS * 2) {
          streamBuffer = streamBuffer.slice(-STREAM_DISPLAY_CHARS);
        }
        onUpdate?.({ content: [{ type: "text", text: streamBuffer }], details: {} });
      });

      // Esc kills the sub-session with its own abort; the model call stops
      // and the transcript up to that point stays on disk.
      const onAbort = () => {
        void session.abort();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      try {
        signal?.throwIfAborted();
        await session.prompt(params.task, { expandPromptTemplates: false, source: "extension" });

        const transcript = session.sessionFile;
        if (signal?.aborted) {
          throw new Error(`subagent cancelled; transcript: ${transcript ?? "not persisted"}`);
        }

        const message = lastAssistantMessage(session);
        if (!message) {
          throw new Error(`subagent produced no assistant response; transcript: ${transcript ?? "not persisted"}`);
        }
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          throw new Error(
            `subagent ${message.stopReason}: ${message.errorMessage ?? "no error details"}; transcript: ${transcript ?? "not persisted"}`,
          );
        }

        const report = assistantText(message);
        if (!report) {
          throw new Error(`subagent produced no final text; transcript: ${transcript ?? "not persisted"}`);
        }

        const usage = sumUsage(session);
        const trunc = truncateHead(report, {});
        let content = trunc.content;
        if (trunc.truncated) {
          content += `\n\n[Summary truncated: kept ${trunc.outputLines}/${trunc.totalLines} lines (${trunc.outputBytes}/${trunc.totalBytes} bytes). Full transcript: ${transcript}]`;
        }
        if (message.stopReason === "length") {
          content += "\n\n[Subagent output stopped at the model output limit and may be incomplete.]";
        }
        content += `\n\nSubagent transcript: ${transcript ?? "(not persisted)"}`;

        return {
          content: [{ type: "text" as const, text: content }],
          details: { transcript, model: `${model.provider}/${model.id}`, reasoning: thinkingLevel },
          ...(usage ? { usage } : {}),
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        session.dispose();
      }
    },
  });
}
