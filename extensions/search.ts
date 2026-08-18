// pi-search: thin TypeScript glue for the Zig web search backend.
//
// pi extensions must be TypeScript modules, so this file registers the
// web_search tool and bridges calls to src/search.zig over the shared
// newline-delimited JSON pipe. All search logic lives in Zig: the Exa
// request body, the response parse, result formatting, and the deadline.
//
// The glue's only jobs: read the user's Exa API key from the environment,
// forward the call, and carry the backend-reported Exa cost through as the
// tool result's usage field so /usage aggregates web_search under the Tools
// provider. Esc aborts by killing and respawning the backend, so no HTTP
// request can outlive its turn.
//
// Protocol:
//   -> {"id":1,"op":"search","query":"...","mode":"answer","num_results":8,"recency":"week","domains":["example.com","-bad.com"],"api_key":"...","timeout_ms":30000}
//   <- {"id":1,"ok":true,"result":"...","usage":{...}} | {"id":1,"ok":false,"error":"..."}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { createBackend, handleSessionShutdown } from "./lib/backend";
import { toolError, withAbort } from "./lib/toolkit";

const TOOL_NAME = "web_search";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_NUM_RESULTS = 8;

// onOk resolves the full response line: the search result text plus the
// backend-reported usage (Exa's cost in USD), which the tool result carries
// so /usage can count it.
const backend = createBackend("pi-search", { onOk: (msg) => msg });

export default function searchExtension(pi: ExtensionAPI) {
  pi.on("session_shutdown", (event) => handleSessionShutdown(backend, event));

  pi.registerTool({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      "Search the web via the Exa API and return a numbered source list with excerpts. Exa returns raw results with no built-in answer synthesis, so write the answer yourself and cite sources as [n] markers resolving to the numbered list. Mode 'answer' (default) returns sources with longer excerpts for synthesis; mode 'results' returns a compact list only, faster and cheaper. Use web_search for current, niche, or factual queries; when you need full page content, fetch the result URLs with the browser tools.",
    promptSnippet: "Search the web and return an answer with cited sources",
    promptGuidelines: [
      "Use web_search when a question needs current, niche, or factual information the model may not know: recent events, version numbers, API docs, prices, or anything with a right answer on the web. The backend searches Exa and returns a numbered source list with excerpts; Exa does not synthesize answers, so write the answer yourself and cite sources as [n] markers resolving to the numbered list.",
      "Default mode 'answer' returns sources with longer excerpts for synthesis. Use mode 'results' for quick lookups where only the source list matters, it is faster and cheaper.",
      "recencyFilter narrows to the past day/week/month/year (Exa filters by published date); domainFilter restricts to domains (prefix with - to exclude, e.g. [\"openai.com\", \"-reddit.com\"]).",
      "When a source's full content matters (API docs, long articles), fetch the URL with browser tools after searching instead of re-searching.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      mode: Type.Optional(
        StringEnum(["answer", "results"], {
          description: "answer returns sources with longer excerpts for synthesis (default); results returns a compact source list only, faster.",
          default: "answer",
        }),
      ),
      numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Preferred number of distinct sources (default 8)." })),
      recencyFilter: Type.Optional(
        StringEnum(["day", "week", "month", "year"], {
          description: "Restrict to sources from the past day, week, month, or year.",
        }),
      ),
      domainFilter: Type.Optional(Type.Array(Type.String({ description: "Restrict to this domain; prefix with - to exclude (e.g. [\"openai.com\", \"-reddit.com\"])." }))),
    }),
    async execute(_toolCallId, params, signal, _onUpdate) {
      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) {
        return toolError("web_search needs the EXA_API_KEY environment variable (export it in your shell before starting pi)");
      }
      try {
        const res = await withAbort(
          backend,
          backend.call("search", {
            query: params.query,
            mode: params.mode ?? "answer",
            num_results: params.numResults ?? DEFAULT_NUM_RESULTS,
            recency: params.recencyFilter,
            domains: params.domainFilter,
            api_key: apiKey,
            timeout_ms: DEFAULT_TIMEOUT_MS,
          }),
          signal,
          "web_search",
        );
        // Exa's cost (USD) rides on the backend usage JSON; forward it so
        // /usage aggregates web_search under the Tools provider.
        return { content: [{ type: "text", text: res.result }], details: {}, ...(res.usage ? { usage: res.usage } : {}) };
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
