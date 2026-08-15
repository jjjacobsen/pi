// Shared tool glue helpers for the HTTP-delegating extensions (search,
// vision). Both register a tool whose call may block the backend in an HTTP
// request, so both need the same abort and error-shaping behavior.

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
