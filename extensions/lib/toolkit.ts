// Small shared helpers for the extension glue: tool-error shaping for
// the HTTP-delegating tools (search, vision) and Codex subscription auth.

import { calculateCost } from "@earendil-works/pi-ai/compat";

// Shape a failure as a tool error: pi marks returned tool results as
// successful and only thrown errors as failures, so this throws. The model
// sees the message as a failed tool call.
export function toolError(text): never {
  throw new Error(text);
}

// ---------------------------------------------------------------------------
// Codex subscription auth (shared by web_search and the /usage limits fetch)
// ---------------------------------------------------------------------------

// Pick an openai-codex model from pi's model registry, preferring the
// mid-tier ("terra") like the current Codex routing does.
export function pickCodexModel(ctx) {
  const models = ctx.modelRegistry.getAll();
  const codex = models.filter(
    (m) => m.provider === "openai-codex" && !m.id.split("-").some((s) => s === "pro" || s === "ultra"),
  );
  if (codex.length === 0) return undefined;
  return codex.find((m) => m.id.includes("terra")) ?? codex[0];
}

// Decode the account id / email from a Codex OAuth JWT's claims.
export function codexJwtClaims(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return {
      accountId: payload?.["https://api.openai.com/auth"]?.chatgpt_account_id,
      email: payload?.["https://api.openai.com/profile"]?.email,
    };
  } catch {
    return {};
  }
}

// Resolve the Codex subscription bearer token through pi's model registry
// (refresh and auth.json rewriting stay in pi), plus the JWT account id and
// the provider's extra headers.
export async function resolveCodexAuth(ctx) {
  const model = pickCodexModel(ctx);
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers ?? {}, ...codexJwtClaims(auth.apiKey) };
}

// Convert a backend usage JSON object into pi's AgentToolResult.usage shape.
// Token fields come from the backend; cost is computed from the model's own
// pricing via pi's accounting (calculateCost), so the reported totals match
// pi's footer and the /usage aggregator.
export function toToolUsage(model, u) {
  if (!u) return undefined;
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: u.totalTokens ?? input + output + cacheRead + cacheWrite,
    reasoning: u.reasoning ?? undefined,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  try {
    calculateCost(model, usage);
  } catch {
    // Model has no pricing; tokens still count, cost stays zero.
  }
  return usage;
}
