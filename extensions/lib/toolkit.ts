// Small shared helpers for the extension glue: abort/tool-error shaping for
// the HTTP-delegating tools (search, vision) and command argument
// completions for commands that take a subcommand or flag (goal, wt).

// Argument completions for a command with a fixed set of words: complete the
// current token, stop once a space follows (multi-word args are free-form).
// Returns AutocompleteItem[] or null when there is nothing to suggest.
export function prefixCompletions(words, prefix) {
  const trimmed = (prefix ?? "").trimStart();
  if (!trimmed) return words.map((w) => ({ value: w, label: w }));
  if (trimmed.includes(" ")) return null;
  const filtered = words.filter((w) => w.startsWith(trimmed));
  return filtered.length > 0 ? filtered.map((w) => ({ value: w, label: w })) : null;
}

// Bridge a backend call with abort support: Esc during the call kills the
// backend (it may be blocked in an HTTP request) and spawns a fresh one, so
// no request can outlive its turn. `label` names the tool in the abort error.
export function withAbort(backend, call, signal, label = "tool call") {
  if (!signal) return call;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`${label} aborted`));
      backend.restart();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// Shape a failure as a tool error result (shown to the model, not thrown).
export function toolError(text) {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}
