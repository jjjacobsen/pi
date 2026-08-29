// Small shared helpers for tool-error shaping and Codex subscription auth.

// Shape a failure as a tool error: pi marks returned tool results as
// successful and only thrown errors as failures, so this throws. The model
// sees the message as a failed tool call.
export function toolError(text): never {
  throw new Error(text);
}

// ---------------------------------------------------------------------------
// Codex subscription auth for the /status limits fetch
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
