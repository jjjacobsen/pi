// pi-btw: /btw side-chat command glue for the Zig btw backend.
//
// Thin TS: registers the /btw command, renders the in-session side-chat
// window (ctx.ui.custom replaces the editor area while the transcript stays
// visible above), and streams the model answer through pi's provider
// registry (the only place provider credentials are reachable). All thread
// logic lives in the Zig backend (src/btw.zig): the ELI15 system prompt,
// history assembly, formatting, and pbcopy.
//
// UX (modeled on opencode-go's by-the-way panel):
//   /btw <question>   open the side chat with the question asked
//   /btw              open the side chat, type the first question
//   enter             send the question (queued while an answer streams)
//   c                 copy the Q&A thread to the clipboard
//   b                 bring the Q&A into the main chat
//   esc               dismiss, main chat untouched
// The window stays inside the session TUI: the transcript remains visible
// above it, exactly like a window expanding in the chat.
//
// Protocol (one JSON object per line):
//   -> {"id":1,"op":"open","context":"...","question":"optional"}
//   <- {"id":1,"ok":true,"system_prompt":"...","messages":[...],"thinking":"low","max_tokens":800}
//   -> {"id":2,"op":"ask","question":"..."}   <- {"id":2,"ok":true,"messages":[...]}
//   -> {"id":3,"op":"answer","answer":"..."}  <- {"id":3,"ok":true,"turns":2}
//   -> {"id":4,"op":"abort"}                  <- {"id":4,"ok":true,"turns":1}
//   -> {"id":5,"op":"format"}                 <- {"id":5,"ok":true,"text":"Q: ...\nA: ..."}
//   -> {"id":6,"op":"copy"}                   <- {"id":6,"ok":true,"chars":123}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Input } from "@earendil-works/pi-tui";
import { createBackend, killOnHostTeardown } from "./lib/backend";

const backend = createBackend("pi-btw");

const BTW_CUSTOM_TYPE = "btw";
const MAX_CONTEXT_CHARS = 48 * 1024; // glue-side cap; the backend truncates to its own
const WINDOW_HEIGHT_RATIO = 0.4; // side chat may use up to 40% of the terminal rows

function notify(ctx, text, level = "info") {
  try {
    ctx.ui?.notify?.(`[btw] ${text}`, level);
  } catch {
    // headless sessions have no UI
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Plain-text excerpt of the main conversation for the side thread's
// background context: user/assistant text blocks, newest-biased, capped.
function buildConversationContext(ctx) {
  const sections = [];
  for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(message.content);
    if (text.length === 0) continue;
    sections.push(text);
  }
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;
  return `[Earlier context omitted]\n${joined.slice(-MAX_CONTEXT_CHARS)}`;
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text.trim());
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[tool: ${block.name}]`);
    }
  }
  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Side-chat window component

class SideChatWindow {
  constructor({ tui, theme, keybindings, input, state, onDismiss, onCopy, onBranch }) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.input = input; // pi-tui Input (single line, handles editing/paste/IME)
    this.state = state; // { turns, pending, answering, partial, error } shared with the handler
    this.onDismiss = onDismiss;
    this.onCopy = onCopy;
    this.onBranch = onBranch;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // Focusable: forward focus to the Input child so the hardware cursor and
  // IME candidate window track the text field.
  get focused() {
    return this.input.focused;
  }
  set focused(value) {
    this.input.focused = value;
  }

  requestRender() {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data) {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onDismiss();
      return;
    }
    // Bare c/b act as shortcuts only when the composer is empty and there is
    // a thread to act on; while typing they are ordinary characters.
    if (this.input.getValue() === "" && !this.state.answering && this.state.turns.length > 0) {
      if (data === "c") {
        this.onCopy();
        return;
      }
      if (data === "b") {
        this.onBranch();
        return;
      }
    }
    this.input.handleInput(data);
    // The TUI re-renders after every keystroke; invalidate so the render
    // cache never serves a stale frame without the typed text.
    this.invalidate();
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.input.invalidate();
  }

  render(width) {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const maxRows = Math.min(20, Math.max(5, Math.floor(windowRows * WINDOW_HEIGHT_RATIO)));
    const lines = [];
    const contentWidth = Math.max(10, width - 2);

    lines.push(theme.fg("accent", theme.bold("btw")) + theme.fg("dim", " · side chat"));
    lines.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))));

    const body = [];
    const turns = this.state.turns;
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      for (const line of wrapQ(`Q: ${turn.question}`, contentWidth)) {
        body.push(theme.fg("userMessageText", line));
      }
      if (turn.answer != null) {
        for (const line of wrapQ(`A: ${turn.answer}`, contentWidth)) {
          body.push(line);
        }
      } else if (this.state.error && ti === turns.length - 1) {
        body.push(theme.fg("error", `⚠ ${this.state.error}`));
      } else {
        body.push(theme.fg("dim", "…"));
      }
    }
    // Streaming partial answer replaces the trailing placeholder.
    if (this.state.answering && this.state.partial) {
      const wrapped = wrapQ(`A: ${this.state.partial}`, contentWidth);
      if (wrapped.length > 0) {
        if (body.length > 0) body.pop();
        for (let i = 0; i < wrapped.length; i++) {
          const last = i === wrapped.length - 1;
          body.push(last ? `${wrapped[i]}${this.theme.fg("dim", "…")}` : wrapped[i]);
        }
      }
    }
    // Queued follow-ups.
    for (const q of this.state.pending) {
      const qLines = wrapQ(`Q: ${q}`, contentWidth);
      for (let i = 0; i < qLines.length; i++) {
        const line = i === qLines.length - 1 ? `${qLines[i]}${theme.fg("dim", " · queued")}` : qLines[i];
        body.push(theme.fg("userMessageText", line));
      }
    }

    const bodyBudget = maxRows - 5; // header, divider, answering line, composer, footer
    const shown = body.slice(-Math.max(1, bodyBudget));
    for (const line of shown) lines.push(line);

    if (this.state.answering && !this.state.partial) {
      lines.push(theme.fg("dim", "answering…"));
    }
    lines.push("");

    // Composer line: the Input component renders its own prompt marker and
    // the fake cursor marker for hardware cursor placement.
    const inputLine = this.input.render(Math.max(1, width))[0] ?? "";
    lines.push(inputLine);

    const hints = [];
    hints.push("enter send");
    if (this.state.turns.length > 0 && !this.state.answering) hints.push("c copy");
    if (this.state.turns.length > 0 && !this.state.answering) hints.push("b branch to chat");
    hints.push("esc dismiss");
    lines.push(theme.fg("dim", hints.join(" · ")));

    // The window grows with content up to maxRows; never below a compact
    // minimum so the composer area stays stable.
    const minRows = Math.min(maxRows, Math.max(7, lines.length));
    while (lines.length < minRows) lines.push("");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function wrapQ(text, width) {
  return wrapTextWithAnsi(text, width);
}

// Terminal row count, cached per render cycle by the TUI; the factory sets
// it once from tui.terminal.rows.
let windowRows = 24;

// ---------------------------------------------------------------------------
// Command

function registerBtwCommand(pi) {
  pi.registerCommand("btw", {
    description: "Ask a quick side question in a side chat: /btw [question]. c copy · b branch to chat · esc dismiss",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        notify(ctx, "only available in the pi TUI", "warning");
        return;
      }
      const question = (args ?? "").trim();

      // Resolve the model before opening the window so failures surface as a
      // notification with no UI churn.
      const model = ctx.model;
      if (!model) {
        notify(ctx, "no model selected", "error");
        return;
      }
      let auth;
      try {
        auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      } catch (err) {
        notify(ctx, `model credentials failed: ${err?.message ?? err}`, "error");
        return;
      }
      if (!auth?.ok) {
        notify(ctx, `model credentials failed: ${auth?.error ?? "unknown"}`, "error");
        return;
      }
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) {
        notify(ctx, `no provider for ${model.provider}`, "error");
        return;
      }

      // Open the side thread in the Zig backend (resets any previous one).
      let openResp;
      try {
        openResp = await backend.call("open", {
          context: buildConversationContext(ctx),
          question: question || undefined,
        });
      } catch (err) {
        notify(ctx, `backend error: ${err?.message ?? err}`, "error");
        return;
      }
      const systemPrompt = openResp.system_prompt ?? "";
      const thinking = openResp.thinking ?? "low";
      const maxTokens = openResp.max_tokens ?? 800;

      // Side-chat state, shared between the handler and the window so the
      // window always renders the live values (not snapshots).
      const turns = []; // {question, answer?}
      const pending = []; // queued follow-ups while an answer streams
      const state = {
        turns,
        pending,
        answering: Boolean(question), // the initial question streams right away
        partial: "",
        error: null,
      };
      let controller = null;
      let dismissed = false;
      let input = new Input();

      // Stream one answer for the given question with the given messages.
      // resolve() is called with the final answer text (or null on error).
      const streamAnswer = (messages, resolve) => {
        controller = new AbortController();
        const stream = provider.streamSimple(
          model,
          { systemPrompt, messages },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            reasoning: thinking,
            maxTokens,
            signal: controller.signal,
          },
        );
        let text = "";
        let settled = false;
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          fn();
        };
        (async () => {
          try {
            for await (const event of stream) {
              if (event.type === "text_delta") {
                text += event.delta;
                state.partial = text;
                windowRef?.requestRender();
              } else if (event.type === "error") {
                finish(() => resolve(null, event.error?.errorMessage ?? "model error"));
                return;
              }
            }
            finish(() => resolve(text, null));
          } catch (err) {
            if (controller.signal.aborted) finish(() => resolve(null, "cancelled"));
            else finish(() => resolve(null, err?.message ?? String(err)));
          }
        })();
      };

      // Ask the backend for the message list and stream the answer. The
      // resolved turn (the last one pushed) gets its answer filled in.
      const askQuestion = (q, messagesOverride) => {
        state.error = null;
        const messagesPromise = messagesOverride
          ? Promise.resolve(messagesOverride)
          : backend.call("ask", { question: q }).then((r) => r.messages);
        return messagesPromise.then((messages) => {
          return new Promise((resolve) => {
            streamAnswer(messages, (text, err) => {
              const turn = turns[turns.length - 1];
              if (err) {
                state.error = err;
                if (err !== "cancelled") {
                  // Not recorded in the backend history; drop the turn so
                  // follow-ups build on answered turns only.
                  backend.call("abort").catch(() => {});
                }
                state.answering = false;
                state.partial = "";
                windowRef?.requestRender();
                resolve();
                return;
              }
              turn.answer = text;
              state.answering = false;
              state.partial = "";
              windowRef?.requestRender();
              backend.call("answer", { answer: text }).catch(() => {});
              resolve();
            });
          });
        });
      };

      // Start answering a question that is already the last turn, then run
      // queued follow-ups one at a time as each answer completes.
      const startAsk = (q, messagesOverride) => {
        state.answering = true;
        windowRef?.requestRender();
        return askQuestion(q, messagesOverride).then(() => {
          if (dismissed || pending.length === 0) return;
          const next = pending.shift();
          while (turns.length > 0 && turns[turns.length - 1].answer == null) turns.pop();
          turns.push({ question: next });
          startAsk(next);
        });
      };

      // Send a question from the composer. While an answer streams, the
      // question is queued and answered in order.
      const submit = (text) => {
        const q = text.trim();
        if (!q) return;
        input.setValue("");
        if (state.answering) {
          pending.push(q);
          windowRef?.requestRender();
          return;
        }
        // A failed answer leaves a ghost turn (the backend dropped it via
        // abort); drop it too so the window matches the backend history.
        while (turns.length > 0 && turns[turns.length - 1].answer == null) turns.pop();
        turns.push({ question: q });
        startAsk(q);
      };

      const dismiss = () => {
        dismissed = true;
        if (controller) {
          controller.abort();
          controller = null;
        }
        backend.call("abort").catch(() => {});
        doneRef(null);
      };

      const copy = async () => {
        try {
          const r = await backend.call("copy");
          notify(ctx, `copied ${r.chars} chars to the clipboard`, "info");
        } catch (err) {
          notify(ctx, err?.message ?? String(err), "warning");
        }
      };

      const branch = async () => {
        try {
          const r = await backend.call("format");
          const text = r.text ?? "";
          if (!text) {
            notify(ctx, "nothing to bring into the main chat yet", "warning");
            return;
          }
          pi.sendMessage({
            customType: BTW_CUSTOM_TYPE,
            content: text,
            display: true,
            details: { turns: turns.length },
          });
          notify(ctx, "side chat brought into the main chat", "success");
        } catch (err) {
          notify(ctx, err?.message ?? String(err), "warning");
          return;
        }
        doneRef(null);
      };

      let windowRef = null;
      let doneRef = () => {};

      await ctx.ui.custom((tui, theme, keybindings, done) => {
        windowRows = tui.terminal?.rows ?? 24;
        doneRef = done;
        const window = new SideChatWindow({
          tui,
          theme,
          keybindings,
          input,
          state,
          onDismiss: dismiss,
          onCopy: copy,
          onBranch: branch,
        });
        windowRef = window;
        input.onSubmit = (text) => submit(text);
        // The initial question (from /btw <question>) was already recorded
        // by the backend's open; stream it with the open response messages.
        if (question) {
          turns.push({ question });
          startAsk(question, openResp.messages);
        }
        return window;
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Message renderer: how a brought-into-main-chat Q&A block looks

function registerBtwMessageRenderer(pi) {
  pi.registerMessageRenderer(BTW_CUSTOM_TYPE, (message, _options, theme) => {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const lines = text.split("\n").map((line) => theme.fg("text", line));
    const header = theme.fg("accent", theme.bold("btw")) + theme.fg("dim", " · side chat");
    return {
      render(width) {
        const out = [theme.fg("borderMuted", "─".repeat(Math.max(0, width))), header];
        for (const line of lines) out.push(line);
        return out;
      },
      invalidate() {},
      handleInput() {},
    };
  });
}

export default function btw(pi: ExtensionAPI) {
  pi.on("session_shutdown", (event) => killOnHostTeardown(backend, event));
  registerBtwCommand(pi);
  registerBtwMessageRenderer(pi);
}
