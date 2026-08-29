// pi-search: web search via the Exa API.
//
// This extension posts directly to Exa, formats the raw results as a numbered
// source list, and forwards Exa's reported cost into pi's session totals.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { toolError } from "./lib/toolkit";

const TOOL_NAME = "web_search";
const EXA_URL = "https://api.exa.ai/search";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_NUM_RESULTS = 8;
const RETRY_BACKOFF_MS = 500;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_ANSWER = 32 * 1024;
const MAX_SNIPPET = 250;
const MAX_EXCERPT = 900;
const MAX_SOURCES = 30;
const MAX_NUM_RESULTS = 10;

const recencyDays = { day: 1, week: 7, month: 30, year: 365 };

function trimAscii(text) {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

function truncateUtf8(text, cap) {
  const bytes = Buffer.from(text);
  if (bytes.length <= cap) return text;
  return bytes.subarray(0, cap).toString("utf8").replace(/\uFFFD$/, "");
}

function normalizeText(text, cap) {
  let out = "";
  let bytes = 0;
  let lastSpace = true;
  for (const char of text) {
    if (char === "\n" || char === "\r" || char === "\t") {
      if (!lastSpace && out.length > 0) {
        out += " ";
        bytes++;
        lastSpace = true;
      }
      continue;
    }
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > cap) break;
    out += char;
    bytes += charBytes;
    lastSpace = false;
    if (bytes === cap) break;
  }
  return trimAscii(out);
}

function isoDateAgo(days) {
  const date = new Date(Date.now() - days * 86400000);
  date.setUTCMilliseconds(0);
  return date.toISOString();
}

function buildBody(query, numResults, recency, domains, excerptCap) {
  const includeDomains = [];
  const excludeDomains = [];
  for (const raw of domains ?? []) {
    const domain = trimAscii(raw);
    if (!domain) continue;
    if (domain.startsWith("-")) {
      const blocked = trimAscii(domain.slice(1));
      if (blocked) excludeDomains.push(blocked);
    } else {
      includeDomains.push(domain);
    }
  }

  const days = typeof recencyDays[recency] === "number" ? recencyDays[recency] : undefined;
  return JSON.stringify({
    query,
    numResults: Math.min(numResults, MAX_NUM_RESULTS),
    type: "auto",
    useAutoprompt: false,
    ...(includeDomains.length > 0 ? { includeDomains } : {}),
    ...(excludeDomains.length > 0 ? { excludeDomains } : {}),
    ...(days ? { startPublishedDate: isoDateAgo(days) } : {}),
    contents: { text: { maxCharacters: excerptCap } },
  });
}

async function readBody(response, cap) {
  if (!response.body) return "";
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > cap) throw new Error("Exa response too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function exaError(response) {
  const text = await readBody(response, 8192).catch(() => "");
  let message = "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === "string" && parsed.error) message = parsed.error;
    else if (typeof parsed?.message === "string" && parsed.message) message = parsed.message;
  } catch {}
  return new Error(`Exa API error ${response.status}${message ? `: ${message}` : ""}`);
}

function formatResults(parsed, excerptCap) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Exa response is not valid JSON");
  if (!Array.isArray(parsed.results)) throw new Error("Exa response is missing results");

  const sources = [];
  const urls = new Set();
  for (const result of parsed.results) {
    if (!result || typeof result !== "object") continue;
    const url = typeof result.url === "string" ? trimAscii(result.url) : "";
    if (!url || urls.has(url) || sources.length >= MAX_SOURCES) continue;
    urls.add(url);
    sources.push({
      url,
      title: normalizeText(typeof result.title === "string" ? result.title : "", 200),
      snippet: normalizeText(typeof result.text === "string" ? result.text : "", excerptCap),
    });
  }

  const usage = typeof parsed.costDollars?.total === "number" && parsed.costDollars.total > 0
    ? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        reasoning: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: parsed.costDollars.total },
      }
    : undefined;

  if (sources.length === 0) return { text: "No results found.", usage };

  let text = "Sources:\n";
  for (const [index, source] of sources.entries()) {
    if (Buffer.byteLength(text) >= MAX_ANSWER) break;
    text += `${index + 1}. ${source.title || source.url} (${source.url})\n`;
    if (source.snippet) text += `   ${source.snippet}\n`;
  }
  return { text: truncateUtf8(text, MAX_ANSWER), usage };
}

function sleep(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function interruptionError(callerSignal) {
  if (callerSignal?.aborted) return new Error("web_search aborted");
  return new Error(`search timed out after ${DEFAULT_TIMEOUT_MS}ms`);
}

async function search(params, apiKey, callerSignal) {
  const query = trimAscii(params.query);
  if (!query) throw new Error("missing query");
  apiKey = trimAscii(apiKey);
  if (!apiKey) throw new Error("missing api_key (EXA_API_KEY)");

  const mode = params.mode ?? "answer";
  if (mode !== "answer" && mode !== "results") throw new Error("mode must be answer or results");
  const excerptCap = mode === "results" ? MAX_SNIPPET : MAX_EXCERPT;
  const body = buildBody(
    query,
    params.numResults ?? DEFAULT_NUM_RESULTS,
    params.recencyFilter,
    params.domainFilter,
    excerptCap,
  );
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(EXA_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body,
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        const error = await exaError(response);
        if ((response.status === 429 || (response.status >= 500 && response.status <= 599)) && attempt === 0) {
          await sleep(RETRY_BACKOFF_MS, signal);
          continue;
        }
        throw error;
      }

      const text = await readBody(response, MAX_BODY);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Exa response is not valid JSON");
      }
      return formatResults(parsed, excerptCap);
    } catch (error) {
      if (signal.aborted) throw interruptionError(callerSignal);
      if (error instanceof TypeError && attempt === 0) {
        try {
          await sleep(RETRY_BACKOFF_MS, signal);
        } catch {
          throw interruptionError(callerSignal);
        }
        continue;
      }
      throw error;
    }
  }
}

export default function searchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      "Search the web via the Exa API and return a numbered source list with excerpts. Exa returns raw results with no built-in answer synthesis, so write the answer yourself and cite sources as [n] markers resolving to the numbered list. Mode 'answer' (default) returns sources with longer excerpts for synthesis; mode 'results' returns a compact list only, faster and cheaper. Use web_search for current, niche, or factual queries.",
    promptSnippet: "Search the web and return an answer with cited sources",
    promptGuidelines: [
      "Use web_search when a question needs current, niche, or factual information the model may not know: recent events, version numbers, API docs, prices, or anything with a right answer on the web. The extension searches Exa and returns a numbered source list with excerpts; Exa does not synthesize answers, so write the answer yourself and cite sources as [n] markers resolving to the numbered list.",
      "Default mode 'answer' returns sources with longer excerpts for synthesis. Use mode 'results' for quick lookups where only the source list matters, it is faster and cheaper.",
      "recencyFilter narrows to the past day/week/month/year (Exa filters by published date); domainFilter restricts to domains (prefix with - to exclude, e.g. [\"openai.com\", \"-reddit.com\"]).",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      mode: Type.Optional(
        StringEnum(["answer", "results"], {
          description: "answer returns sources with longer excerpts for synthesis (default); results returns a compact source list only, faster.",
          default: "answer",
        }),
      ),
      numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Preferred number of distinct sources (default 8)." })),
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
        const result = await search(params, apiKey, signal);
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {},
          ...(result.usage ? { usage: result.usage } : {}),
        };
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
