// pi-goal: /goal command glue for the Zig goal backend (src/goal.zig).
//
// Thin TS: registers the /goal command, the goal_complete / goal_blocked /
// goal_wait tools, and the pi lifecycle wiring. All decisions live in the Zig
// backend over a newline-delimited JSON pipe: goal state, boundaries (min/max
// time and tokens), continuation prompts, tool validation, and the no-progress
// guard. This file only moves events and data between pi and the backend.
//
// Protocol (one JSON object per line):
//   -> {"id":1,"op":"parse","args":"fix bug --min-time 1h"}
//   -> {"id":2,"op":"start","objective":"...","tokens":12345,...}   <- {"id":2,"ok":true,"state":{...},"action":"send","prompt":"..."}
//   -> {"id":3,"op":"event","event":"agent_end","state":{...},...}   <- {"id":3,"ok":true,"state":{...},"action":"continue","prompt":"..."}
//   -> {"id":4,"op":"complete","state":{...},"goal_id":"...","summary":"..."}
//   <- {"id":4,"ok":false,"error":"...","remaining_tokens":60000}
//
// Actions: none (nothing to do), continue (store the prompt as the pending
// continuation), send (deliver the prompt as a follow-up message now), inject
// (return the prompt as a system-prompt addition), stop (goal stopped; notify
// with `text`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBackend, handleSessionShutdown } from "./lib/backend";
import { prefixCompletions } from "./lib/toolkit";

const STATUS_KEY = "goal";
const STATE_ENTRY_TYPE = "goal-state";
const MAX_GOAL_ID_LENGTH = 64;

const backend = createBackend("pi-goal", { onError: (msg) => msg.error ?? "goal backend error" });
// ----- runtime state (mirror of the backend's canonical state) -----

let state = null; // parsed goal state object, or null when no goal
let intent = null; // pending continuation prompt ({ prompt })
let waitTimer = null;

function clearWaitTimer() {
  if (waitTimer !== null) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// All session entries on the current branch, newest last.
function sessionEntries(ctx) {
  return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
}

// Cumulative assistant tokens across the session branch; the goal baseline
// captured at start is subtracted by the backend.
function cumulativeTokens(ctx) {
  let total = 0;
  const entries = sessionEntries(ctx);
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue;
    if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
      total += usage.totalTokens;
      continue;
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const v = usage[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) total += v;
    }
  }
  return total;
}

// Find the last assistant message in a run's messages (agent_end payload).
function finalAssistant(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    return message;
  }
  return undefined;
}

// Visible assistant text and whether any tool was called in a run's messages.
function assistantOutput(messages) {
  const text = [];
  let toolCalled = false;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      if (block.type === "toolCall") toolCalled = true;
    }
  }
  return { text: text.join("\n"), toolCalled };
}

// ----- persistence (goal state survives compaction and session reload) -----

function persistState(pi) {
  pi.appendEntry(STATE_ENTRY_TYPE, { goal: state, ts: Date.now() });
}

function loadStateFromSession(ctx) {
  const entries = sessionEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry?.customType !== STATE_ENTRY_TYPE) continue;
    return isRecord(entry.data) ? (entry.data.goal ?? null) : null;
  }
  return null;
}

// ----- UI helpers -----

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[goal] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

function setStatus(ctx, statusline) {
  try {
    ctx.ui?.setStatus?.(STATUS_KEY, statusline ?? undefined);
  } catch {
    // headless sessions have no UI
  }
}

async function sendPrompt(pi, ctx, prompt) {
  try {
    await pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return true;
  } catch (err) {
    notify(ctx, `prompt delivery failed: ${err?.message ?? err}`, "error");
    return false;
  }
}

// Dispatch the pending continuation (or a due wait deadline) only when pi is
// fully settled and idle. Called from agent_settled, wait-deadline timers, and
// post-compaction.
async function dispatchIfSettled(pi, ctx) {
  if (!state) return false;
  if (!intent && !state.waiting) return false;
  const resp = await backend.call("event", {
    event: "settled",
    state,
    idle: ctx.isIdle?.() === true,
    pending: ctx.hasPendingMessages?.() === true,
    has_intent: intent !== null,
  });
  if (resp.state !== undefined) state = resp.state;
  if (resp.action !== "send" || !resp.prompt) return false;
  const prompt = resp.prompt;
  intent = null;
  persistState(pi);
  const sent = await sendPrompt(pi, ctx, prompt);
  if (!sent && state?.status === "active" && !state.waiting) {
    intent = { prompt }; // delivery failed; keep the intent for a later settled
  }
  return sent;
}

function scheduleWaitDeadline(pi, ctx) {
  clearWaitTimer();
  if (!state?.waiting || typeof state.waiting.resume_at !== "number" || state.waiting.resume_at <= 0) {
    return;
  }
  const delay = Math.max(0, state.waiting.resume_at - Date.now());
  waitTimer = setTimeout(() => {
    waitTimer = null;
    if (!state?.waiting) return;
    dispatchIfSettled(pi, ctx);
  }, delay);
}

// ----- tools -----

function toolText(text) {
  return { content: [{ type: "text", text }], details: {} };
}

function toolDetails(extra = {}) {
  return { goal: state?.text ?? "unknown goal", ...extra };
}

function registerTools(pi) {
  const goalCompleteTool = defineTool({
    name: "goal_complete",
    label: "Goal Complete",
    description:
      "Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
    promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
    promptGuidelines: [
      "When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
      "Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
      "Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
      "Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: 4000,
        description:
          "State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) {
        const rejection = "Goal completion rejected: no active goal.";
        notify(ctx, rejection, "warning");
        return toolText(rejection);
      }
      try {
        const resp = await backend.call("complete", {
          state,
          goal_id: typeof params.goal_id === "string" ? params.goal_id.trim() : "",
          summary: typeof params.summary === "string" ? params.summary.trim() : "",
        });
        state = resp.state ?? null;
        persistState(pi);
        setStatus(ctx, resp.statusline);
        if (!resp.ok) {
          notify(ctx, `completion rejected: ${resp.error}`, "warning");
          return { ...toolText(`Goal completion rejected: ${resp.error}`), details: toolDetails({ goal_id: params.goal_id, summary: params.summary }) };
        }
        clearWaitTimer();
        intent = null;
        notify(ctx, "Goal complete.", "success");
        return { ...toolText(resp.text), details: toolDetails({ goal_id: params.goal_id, summary: params.summary }) };
      } catch (err) {
        return { ...toolText(`goal backend error: ${err?.message ?? err}`), details: toolDetails() };
      }
    },
  });

  const goalBlockedTool = defineTool({
    name: "goal_blocked",
    label: "Goal Blocked",
    description:
      "Report a true impasse on the active /goal after the same blocker recurs for at least three consecutive goal turns, with concrete evidence that user or external action is required. Do not use for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
    promptSnippet: "Report a true impasse on the active /goal with the current goal_id",
    promptGuidelines: [
      "Use goal_blocked only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with concrete evidence that user or external action is required.",
      "Do not use goal_blocked merely because work is difficult, incomplete, uncertain, awaiting normal clarification, or affected by a recoverable tool/provider failure.",
      "After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id shown in the current active /goal prompt. Used only to reject stale blocker calls from older turns.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "The specific user or external action required to unblock the goal.",
      }),
      evidence: Type.String({
        minLength: 1,
        maxLength: 4000,
        description: "Concrete evidence from the failed resolution attempts that proves the impasse.",
      }),
      repeated_turns: Type.Integer({
        minimum: 3,
        description:
          "Number of separate goal turns spent trying to resolve this same blocker. Must be at least 3.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) {
        const rejection = "Goal blocked rejected: no active goal.";
        notify(ctx, rejection, "warning");
        return toolText(rejection);
      }
      try {
        const resp = await backend.call("blocked", {
          state,
          goal_id: typeof params.goal_id === "string" ? params.goal_id.trim() : "",
          reason: typeof params.reason === "string" ? params.reason.trim() : "",
          evidence: typeof params.evidence === "string" ? params.evidence.trim() : "",
          repeated_turns: params.repeated_turns,
        });
        state = resp.state ?? null;
        persistState(pi);
        setStatus(ctx, resp.statusline);
        if (!resp.ok) {
          notify(ctx, `blocked rejected: ${resp.error}`, "warning");
          return { ...toolText(`Goal blocked rejected: ${resp.error}`), details: toolDetails({ goal_id: params.goal_id }) };
        }
        clearWaitTimer();
        intent = null;
        notify(ctx, resp.text, "warning");
        return { ...toolText(resp.text), details: toolDetails({ goal_id: params.goal_id }) };
      } catch (err) {
        return { ...toolText(`goal backend error: ${err?.message ?? err}`), details: toolDetails() };
      }
    },
  });

  const goalWaitTool = defineTool({
    name: "goal_wait",
    label: "Goal Wait",
    description:
      "Keep the active /goal alive but quiet while an external event is expected. Call goal_wait alone after arranging a monitor or other wake source that will inject a non-goal message when external state changes.",
    promptSnippet: "Wait quietly for an external event without polling",
    promptGuidelines: [
      "Use goal_wait only when progress genuinely depends on a later external event and a wake message has been arranged.",
      "Call goal_wait alone because pi only guarantees early turn termination when every finalized result in a parallel tool batch terminates.",
      "Prefer deadlines measured in minutes; requests below 10000ms are clamped to 10000ms. Omitting resume_after_ms keeps the goal quiet indefinitely.",
      "Do not use goal_wait for ordinary unfinished work, and do not use goal_blocked for a recoverable external wait.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id shown in the current active /goal prompt. Used only to reject stale wait calls from older turns.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "What external event the goal is waiting for.",
      }),
      resume_after_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 2147483647,
          description:
            "Optional safety wake-up deadline in milliseconds. Prefer minutes; not a polling interval.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) {
        const rejection = "Goal wait rejected: no active goal.";
        notify(ctx, rejection, "warning");
        return toolText(rejection);
      }
      try {
        const resp = await backend.call("wait", {
          state,
          goal_id: typeof params.goal_id === "string" ? params.goal_id.trim() : "",
          reason: typeof params.reason === "string" ? params.reason.trim() : "",
          resume_after_ms: typeof params.resume_after_ms === "number" ? params.resume_after_ms : null,
        });
        state = resp.state ?? null;
        persistState(pi);
        setStatus(ctx, resp.statusline);
        if (!resp.ok) {
          notify(ctx, `wait rejected: ${resp.error}`, "warning");
          return { ...toolText(`Goal wait rejected: ${resp.error}`), details: toolDetails({ goal_id: params.goal_id }) };
        }
        clearWaitTimer();
        intent = null;
        scheduleWaitDeadline(pi, ctx);
        return { ...toolText(resp.text), details: toolDetails({ goal_id: params.goal_id, effective_resume_after_ms: resp.effective_ms }) };
      } catch (err) {
        return { ...toolText(`goal backend error: ${err?.message ?? err}`), details: toolDetails() };
      }
    },
  });

  pi.registerTool(goalCompleteTool);
  pi.registerTool(goalBlockedTool);
  pi.registerTool(goalWaitTool);
}

// ----- command -----

function registerGoalCommand(pi) {
  pi.registerCommand("goal", {
    description:
      "Run a goal to completion: /goal [--min-time 1h] [--max-tokens 500k] [--no-ask] <goal_to_complete>. Also: /goal status | pause | resume | clear",
    getArgumentCompletions: (prefix) =>
      prefixCompletions(["status", "pause", "resume", "clear", "--min-time 1h", "--max-time 1h", "--min-tokens 100k", "--max-tokens 100k", "--no-ask"], prefix),
    handler: async (args, ctx) => {
      let parsed;
      try {
        parsed = await backend.call("parse", { args: args ?? "" });
      } catch (err) {
        return notify(ctx, `parse failed: ${err?.message ?? err}`, "error");
      }
      if (!parsed.ok) return notify(ctx, parsed.error, "warning");
      const tokens = cumulativeTokens(ctx);

      switch (parsed.kind) {
        case "start": {
          if (state && state.status !== "complete") {
            let replace = false;
            try {
              replace = await ctx.ui.confirm?.(
                "Replace the current goal?",
                `A goal is already ${state.status}: ${String(state.text ?? "").slice(0, 120)}\n\nStarting a new /goal replaces it and resets its counters.`,
              );
            } catch {
              replace = true; // headless: no one to ask
            }
            if (replace === false) return notify(ctx, "kept the current goal");
          }
          let resp;
          try {
            resp = await backend.call("start", {
              objective: parsed.objective,
              min_time: parsed.min_time,
              max_time: parsed.max_time,
              min_tokens: parsed.min_tokens,
              max_tokens: parsed.max_tokens,
              no_ask: parsed.no_ask,
              tokens,
            });
          } catch (err) {
            return notify(ctx, err?.message ?? String(err), "error");
          }
          if (!resp.ok) return notify(ctx, resp.error, "warning");
          state = resp.state;
          intent = null;
          clearWaitTimer();
          persistState(pi);
          setStatus(ctx, resp.statusline);
          if (resp.action === "send" && resp.prompt) await sendPrompt(pi, ctx, resp.prompt);
          return;
        }
        case "status": {
          try {
            const resp = await backend.call("status", { state });
            if (resp.ok) {
              notify(ctx, resp.text, "info");
              setStatus(ctx, resp.statusline);
            } else {
              notify(ctx, resp.error, "warning");
            }
          } catch (err) {
            notify(ctx, err?.message ?? String(err), "error");
          }
          return;
        }
        case "pause": {
          if (!state) return notify(ctx, "no active goal", "warning");
          try {
            const resp = await backend.call("pause", { state });
            if (!resp.ok) return notify(ctx, resp.error, "warning");
            state = resp.state;
            intent = null;
            clearWaitTimer();
            persistState(pi);
            setStatus(ctx, resp.statusline);
            notify(ctx, resp.text, "warning");
            try {
              ctx.abort?.();
            } catch {
              // best effort: the goal is paused either way
            }
          } catch (err) {
            notify(ctx, err?.message ?? String(err), "error");
          }
          return;
        }
        case "resume": {
          if (!state) return notify(ctx, "no active goal", "warning");
          try {
            const resp = await backend.call("resume", {
              state,
              min_time: parsed.min_time,
              max_time: parsed.max_time,
              min_tokens: parsed.min_tokens,
              max_tokens: parsed.max_tokens,
            });
            if (!resp.ok) return notify(ctx, resp.error, "warning");
            state = resp.state;
            intent = null;
            clearWaitTimer();
            persistState(pi);
            setStatus(ctx, resp.statusline);
            if (resp.action === "send" && resp.prompt) {
              notify(ctx, resp.text, "info");
              await sendPrompt(pi, ctx, resp.prompt);
            } else {
              notify(ctx, resp.text, "warning");
            }
          } catch (err) {
            notify(ctx, err?.message ?? String(err), "error");
          }
          return;
        }
        case "clear": {
          try {
            const hadGoal = state !== null;
            const resp = await backend.call("clear", { state });
            if (!resp.ok) return notify(ctx, resp.error, "warning");
            state = null;
            intent = null;
            clearWaitTimer();
            if (hadGoal) persistState(pi); // tombstone: a cleared goal must not resurrect
            setStatus(ctx, undefined);
            notify(ctx, resp.text, "info");
          } catch (err) {
            notify(ctx, err?.message ?? String(err), "error");
          }
          return;
        }
      }
    },
  });
}

// ----- lifecycle -----

function registerGoalLifecycle(pi) {
  pi.on("session_start", async (_event, ctx) => {
    clearWaitTimer();
    intent = null;
    const loaded = loadStateFromSession(ctx);
    state = loaded;
    if (!state) {
      setStatus(ctx, undefined);
      return;
    }
    try {
      const resp = await backend.call("restore", { state, tokens: cumulativeTokens(ctx) });
      if (resp.ok) state = resp.state ?? null;
      setStatus(ctx, resp.statusline);
      if (state) scheduleWaitDeadline(pi, ctx);
    } catch (err) {
      notify(ctx, `restore failed: ${err?.message ?? err}`, "error");
    }
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    clearWaitTimer();
    intent = null;
  });

  pi.on("session_before_compact", (_event, ctx) => {
    if (state) persistState(pi);
    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    const loaded = loadStateFromSession(ctx);
    state = loaded;
    if (!state) return;
    try {
      const restored = await backend.call("restore", { state, tokens: cumulativeTokens(ctx) });
      if (!restored.ok) return;
      state = restored.state ?? null;
      setStatus(ctx, restored.statusline);
      if (!state) return;
      if (state.waiting) {
        scheduleWaitDeadline(pi, ctx);
        return;
      }
      const resp = await backend.call("event", { event: "compact", state });
      if (resp.state !== undefined) state = resp.state;
      if (resp.action === "continue" && resp.prompt && state?.status === "active") {
        intent = { prompt: resp.prompt };
        // Manual compaction emits no agent_settled; dispatch on the next tick
        // when pi reports idle. Threshold compaction retries and settles later.
        setTimeout(() => {
          if (intent?.prompt === resp.prompt) dispatchIfSettled(pi, ctx);
        }, 0);
      }
    } catch (err) {
      notify(ctx, `compaction handling failed: ${err?.message ?? err}`, "error");
    }
  });

  pi.on("input", async (event, ctx) => {
    // /goal subcommands are routed to the command handler, not here.
    if (typeof event.text === "string" && /^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
    if (event.source === "extension") return; // our own follow-up prompts never wake a waiting goal
    intent = null; // fresh user input supersedes any pending continuation
    if (!state) return;
    clearWaitTimer();
    try {
      const resp = await backend.call("event", { event: "input", state, user_input: true });
      if (resp.state !== undefined) state = resp.state;
      persistState(pi);
      setStatus(ctx, resp.statusline);
      if (state?.waiting) scheduleWaitDeadline(pi, ctx);
    } catch (err) {
      notify(ctx, `input handling failed: ${err?.message ?? err}`, "error");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state) return undefined;
    try {
      const resp = await backend.call("event", { event: "agent_start", state });
      if (resp.state !== undefined) state = resp.state;
      if (resp.action === "inject" && resp.prompt) {
        return { systemPrompt: `${event.systemPrompt}\n\n${resp.prompt}` };
      }
    } catch {
      // injection is best-effort; the goal prompt itself carries the rules
    }
    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state) return;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const final = finalAssistant(messages);
    const output = assistantOutput(messages);
    try {
      const resp = await backend.call("event", {
        event: "agent_end",
        state,
        tokens: cumulativeTokens(ctx),
        text: output.text,
        tool_called: output.toolCalled,
        error_run: final?.stopReason === "error",
      });
      if (resp.state !== undefined) state = resp.state;
      persistState(pi);
      setStatus(ctx, resp.statusline);
      switch (resp.action) {
        case "continue":
          intent = { prompt: resp.prompt };
          return;
        case "stop":
          intent = null;
          clearWaitTimer();
          notify(ctx, resp.text, "warning");
          return;
        case "send":
          intent = null;
          await sendPrompt(pi, ctx, resp.prompt);
          return;
        default:
          intent = null; // completed, blocked, paused, or waiting
          return;
      }
    } catch (err) {
      notify(ctx, `agent_end handling failed: ${err?.message ?? err}`, "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state) return;
    await dispatchIfSettled(pi, ctx);
  });
}

// ----- entry point -----

export default function goal(pi: ExtensionAPI) {
  pi.on("session_shutdown", (event) => handleSessionShutdown(backend, event));
  registerGoalCommand(pi);
  registerTools(pi);
  registerGoalLifecycle(pi);
}
