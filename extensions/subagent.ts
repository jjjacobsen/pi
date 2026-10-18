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
//   allowlisted search extension. Each worker's resource loader disables
//   extension discovery and loads only search, so other factories never run.
//   The tools allowlist also prevents recursive subagent calls.
// - Model and thinking use saved defaults, then inherit from the caller.
//   Optional per-call overrides take priority over those defaults.
// - The transcript is persisted under <agent_dir>/subagents/<ts>_<id>.jsonl
//   so any run can be resumed (SessionManager.open) or inspected.
// - The subagent's complete session usage rides back on the tool result's usage
//   field, so pi includes the spend in the caller's session totals.
// - Esc aborts the sub-session (signal -> session.abort()); tool activity
//   and elapsed time stream to the TUI via onUpdate.

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
import { renderSubagentCall, renderSubagentResult } from "./lib/subagent-render";

const TOOL_NAME = "subagent";
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// The only extension factory allowed inside a sub-session.
const SEARCH_EXTENSION_PATH = fileURLToPath(new URL("search.ts", import.meta.url));

// The exact tools a subagent can call. The first four are built-ins, and the
// last one comes from the allowlisted extension above.
const SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "web_search"];

const SUBAGENT_INSTRUCTIONS = `You are a subagent, spawned by the main pi session to complete one delegated task.

Rules:
- The task is self-contained. Work independently with your tools until it is done; do not ask the caller for clarification, instead make reasonable assumptions and note them in your report.
- Your final reply is returned verbatim to the calling agent. Write it as a standalone report: what you did, what changed or found, and any caveats or recommended follow-ups.
- End your reply with a short "Summary:" bullet section.`;

// Share only the model catalog + auth runtime. Search registers no providers
// or virtual models, so it does not add session-bound state to this runtime.
// Each worker gets its own resource loader and mutable extension runtime.
let sharedModelRuntimePromise;

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
      "Delegate substantial implementation and investigation by default, before doing the full investigation yourself. The subagent starts with fresh context in the current project directory, with read, bash, edit, write, and web_search. It does not see this conversation and returns only its final summary. Give it a complete task with context, constraints, file ownership, and completion criteria. Run independent tasks in parallel, but do not force tightly coupled work into separate tasks. Review actual changes and run required checks rather than trust summaries alone. Model and reasoning overrides are optional; omit them to use saved /subagent-model and /subagent-thinking defaults, or inherit the parent session if unset. Do not delegate tiny tasks where overhead outweighs the benefit, or tasks where you need the full intermediate output.",
    promptSnippet: "Delegate a self-contained task with a short 3-8 word label to an isolated subagent that returns only a summary",
    promptGuidelines: [
      "Orchestrate substantial implementation and investigation by default. Do only enough initial inspection to define the task, then delegate before doing the full investigation yourself.",
      "Give each subagent a complete, self-contained task with relevant context, constraints, file ownership, and completion criteria. It does not see this conversation and returns only its final message.",
      "Run independent tasks in parallel with one subagent call per task and no overlapping file edits. Keep tightly coupled work together rather than force a split.",
      "Keep responsibility for resolving questions, reviewing actual changes or evidence, integration, and final validation. Run required checks and do not trust summaries alone.",
      "Omit subagent model and reasoning to use saved defaults, or inherit from the parent session if unset. Set only the value that needs an override.",
      "Supply a short 3-8 word label that describes the task, separate from the full task prompt.",
      "Do not delegate tiny tasks where overhead outweighs the benefit, or tasks where you need to see the full intermediate output.",
    ],
    parameters: Type.Object({
      label: Type.String({ description: "Short 3-8 word description of this task, supplied by the parent agent." }),
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
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const details = {
        label: params.label,
        task: params.task,
        status: "running",
        model: undefined as string | undefined,
        reasoning: undefined as string | undefined,
        elapsedMs: 0,
        activity: "Starting subagent",
        transcript: undefined as string | undefined,
        usage: undefined as ReturnType<typeof sumUsage>,
      };
      const update = () => {
        details.elapsedMs = Date.now() - started;
        onUpdate?.({ content: [{ type: "text", text: details.activity }], details: { ...details } });
      };
      update();
      const timer = setInterval(update, 1000);
      let session;
      let unsubscribe;
      let onAbort;
      try {
        signal?.throwIfAborted();
        const config = await readConfig();
        const modelRuntime = await (sharedModelRuntimePromise ??= ModelRuntime.create());
        const reference = params.model ?? config?.model;
        const model = reference ? findExactModel(modelRuntime, reference) : ctx.model;
        if (!model) {
          throw new Error(reference
            ? `subagent: model "${reference}" was not found or is ambiguous. Use an exact provider/model or run /subagent-model`
            : "subagent: no active model in this session");
        }

        details.model = `${model.provider}/${model.id}`;
        update();
        const supportedReasoning = getSupportedThinkingLevels(model);
        if (params.reasoning && !supportedReasoning.includes(params.reasoning)) {
          throw new Error(
            `subagent: reasoning "${params.reasoning}" is not supported by ${model.provider}/${model.id} (supported: ${supportedReasoning.join(", ")})`,
          );
        }
        const thinkingLevel = params.reasoning ?? clampThinkingLevel(model, config?.thinking ?? ctx.thinkingLevel);
        details.reasoning = thinkingLevel;
        details.activity = "Preparing subagent session";
        update();

        const agentDir = getAgentDir();
        const loader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir,
          noExtensions: true,
          additionalExtensionPaths: [SEARCH_EXTENSION_PATH],
          appendSystemPromptOverride: (base) => [...base, SUBAGENT_INSTRUCTIONS],
        });
        await loader.reload();
        const parentSession = ctx.sessionManager.getSessionFile();
        const sessionManager = SessionManager.create(
          ctx.cwd,
          join(agentDir, "subagents"),
          parentSession ? { parentSession } : undefined,
        );
        ({ session } = await createAgentSession({
          cwd: ctx.cwd,
          agentDir,
          model,
          thinkingLevel,
          modelRuntime,
          resourceLoader: loader,
          sessionManager,
          settingsManager: SettingsManager.create(ctx.cwd, agentDir),
          tools: SUBAGENT_TOOLS,
        }));
        details.transcript = session.sessionFile;
        details.activity = "Working";
        update();

        unsubscribe = session.subscribe((event) => {
          if (event.type !== "tool_execution_start") return;
          const args = event.args;
          switch (event.toolName) {
            case "read":
            case "edit":
            case "write":
              details.activity = `${event.toolName}: ${args.path}`;
              break;
            case "bash":
              details.activity = `bash: ${args.command}`;
              break;
            case "web_search":
              details.activity = `web search: ${args.query}`;
              break;
            default:
              return;
          }
          update();
        });

        // Esc kills the sub-session with its own abort; the model call stops
        // and the transcript up to that point stays on disk.
        onAbort = () => {
          void session.abort();
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

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

        details.usage = sumUsage(session);
        const trunc = truncateHead(report, {});
        let content = trunc.content;
        if (trunc.truncated) {
          content += `\n\n[Summary truncated: kept ${trunc.outputLines}/${trunc.totalLines} lines (${trunc.outputBytes}/${trunc.totalBytes} bytes). Full transcript: ${transcript}]`;
        }
        if (message.stopReason === "length") {
          content += "\n\n[Subagent output stopped at the model output limit and may be incomplete.]";
        }
        content += `\n\nSubagent transcript: ${transcript ?? "(not persisted)"}`;

        details.status = "done";
        details.activity = "Complete";
        update();
        return {
          content: [{ type: "text" as const, text: content }],
          details: { ...details },
          ...(details.usage ? { usage: details.usage } : {}),
        };
      } catch (error) {
        if (session) {
          details.transcript = session.sessionFile;
          details.usage = sumUsage(session);
        }
        details.status = signal?.aborted || (session && lastAssistantMessage(session)?.stopReason === "aborted")
          ? "cancelled"
          : "failed";
        details.activity = error instanceof Error ? error.message : String(error);
        update();
        return {
          content: [{ type: "text" as const, text: `subagent ${details.status}: ${details.activity}` }],
          details: { ...details },
          isError: true,
          ...(details.usage ? { usage: details.usage } : {}),
        };
      } finally {
        clearInterval(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        unsubscribe?.();
        session?.dispose();
      }
    },
  });
}
