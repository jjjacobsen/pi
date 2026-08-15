// pi-search: thin TypeScript glue for the Zig web search backend.
//
// pi extensions must be TypeScript modules, so this file registers the
// web_search tool and bridges calls to src/search.zig over the shared
// newline-delimited JSON pipe. All search logic lives in Zig: the request
// body, the SSE stream parse, citation markers, and result formatting.
//
// The glue's only jobs: resolve the Codex subscription auth through pi's
// model registry (the same pattern pi-vision uses for its model), derive
// the chatgpt-account-id header from the token's JWT claims, and forward
// the call. Esc aborts by killing and respawning the backend, so no HTTP
// request can outlive its turn.
//
// Protocol:
//   -> {"id":1,"op":"search","query":"...","mode":"answer","num_results":8,"recency":"week","domains":[...],"endpoint":"https://chatgpt.com/backend-api/codex/responses","api_key":"...","headers":"[[\"h\",\"v\"],...]","model":"gpt-5.6-terra","timeout_ms":60000}
//   <- {"id":1,"ok":true,"result":"..."} | {"id":1,"ok":false,"error":"..."}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { createBackend, killOnHostTeardown } from "./lib/backend";
import { toolError, withAbort } from "./lib/toolkit";

const TOOL_NAME = "web_search";
// The Codex subscription endpoint: same server-side web_search pipeline the
// Codex CLI uses. The token comes from pi's model registry (openai-codex
// provider), so a logged-in Codex account is all this extension needs.
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_NUM_RESULTS = 8;

const backend = createBackend("pi-search", { onOk: (msg) => msg.result });

// ---------------------------------------------------------------------------
// Auth: pick a Codex subscription model, prefer the mid-tier ("terra")
// like the current search routing does, and resolve its token + headers.

function pickSearchModel(ctx) {
  const models = ctx.modelRegistry.getAll();
  const codex = models.filter(
    (m) => m.provider === "openai-codex" && !m.id.split("-").some((s) => s === "pro" || s === "ultra"),
  );
  if (codex.length === 0) return undefined;
  return codex.find((m) => m.id.includes("terra")) ?? codex[0];
}

function codexAccountId(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Backend bridge with abort support lives in lib/toolkit.ts (shared with
// pi-vision): Esc during a search kills the backend (it may be blocked in an
// HTTP request) and spawns a fresh one.

export default function searchExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", (event) => killOnHostTeardown(backend, event));

  pi.registerTool({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      "Search the web and return an answer with cited sources. The search runs server-side on OpenAI's index with model-driven query planning, the same pipeline Codex uses, so the answer is grounded with citations. Mode 'answer' (default) returns the synthesized answer plus the numbered source list; mode 'results' returns only the sources, which is faster. Use web_search for current, niche, or factual queries; when you need full page content, open the result URLs with the browser tools.",
    promptSnippet: "Search the web and return an answer with cited sources",
    promptGuidelines: [
      "Use web_search when a question needs current, niche, or factual information the model may not know: recent events, version numbers, API docs, prices, or anything with a right answer on the web. The backend runs OpenAI's server-side web_search (the Codex pipeline): the model plans queries, the search happens on OpenAI's index, and the answer comes back with [n] citation markers resolving to the numbered source list.",
      "Default mode 'answer' gives a synthesized answer with citations. Use mode 'results' for quick lookups where only the source list matters, it returns in a fraction of the time.",
      "recencyFilter narrows to the past day/week/month/year; domainFilter restricts to domains (prefix with - to exclude, e.g. [\"openai.com\", \"-reddit.com\"]).",
      "When a source's full content matters (API docs, long articles), fetch the URL with browser tools after searching instead of re-searching.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      mode: Type.Optional(
        StringEnum(["answer", "results"], {
          description: "answer returns the synthesized answer with citations plus sources (default); results returns only the source list, faster.",
          default: "answer",
        }),
      ),
      numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Preferred number of distinct sources (default 8)." })),
      recencyFilter: Type.Optional(
        StringEnum(["day", "week", "month", "year"], {
          description: "Restrict to sources from the past day, week, month, or year.",
        }),
      ),
      domainFilter: Type.Optional(Type.Array(Type.String({ description: "Restrict to this domain; prefix with - to exclude (e.g. [\"openai.com\", \"-reddit.com\"])." }))),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = pickSearchModel(ctx);
      if (!model) {
        return toolError("web_search needs a Codex subscription (provider openai-codex). Log in with /login and /reload.");
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        return toolError(`Cannot resolve Codex auth: ${auth.error ?? "no api key"}`);
      }
      const headers = {};
      for (const [k, v] of Object.entries(auth.headers ?? {})) {
        if (v !== null) headers[k] = String(v);
      }
      headers.Authorization = `Bearer ${auth.apiKey}`;
      const accountId = codexAccountId(auth.apiKey);
      if (accountId) headers["chatgpt-account-id"] = accountId;
      headers.originator = "pi";
      headers["OpenAI-Beta"] = "responses=experimental";
      try {
        const text = await withAbort(
          backend,
          backend.call("search", {
            query: params.query,
            mode: params.mode ?? "answer",
            num_results: params.numResults ?? DEFAULT_NUM_RESULTS,
            recency: params.recencyFilter,
            domains: params.domainFilter,
            endpoint: CODEX_RESPONSES_URL,
            api_key: auth.apiKey,
            headers: JSON.stringify(Object.entries(headers).map(([k, v]) => [k, v])),
            model: model.id,
            timeout_ms: DEFAULT_TIMEOUT_MS,
          }),
          signal,
          "web_search",
        );
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return toolError(e.message);
      }
    },
  });
}
