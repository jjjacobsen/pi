// pi-browser: thin TypeScript glue for the Zig headless-browser backend.
//
// pi extensions must be TypeScript modules, so this file only registers
// tool schemas and bridges tool calls to the Zig backend (src/browser.zig)
// through the shared one-shot callZig helper (one JSON argv element, one
// JSON envelope on stdout, exit). All browser logic lives in Zig, which
// posts one MCP tools/call (JSON-RPC 2.0 over HTTP) to the lightpanda MCP
// daemon that launchd keeps running (see docs/daemons.md). The daemon owns
// the pages: every call attaches to a session id sent in the request,
// defaulting to the shared "pi-main" tab. A pi process can be pointed at
// its own tab via browser_pick_session below (the session choice is
// per-process glue state, reset on a pi reload), and tabs can be listed
// and closed via browser_sessions / browser_close_session.
//
// Protocol:
//   -> {"op":"goto","params":"{\"url\":\"...\"}"}   params is a JSON string
//   <- {"ok":true,"result":"..."} | {"ok":false,"error":"..."}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TProperties } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { callZig } from "./lib/zig";
import { toolError } from "./lib/toolkit";

const T = Type;
const enumOpt = (values: string[], description: string) =>
  T.Optional(StringEnum(values, { description }));
const intOpt = (description: string) => T.Optional(T.Integer({ description }));
const strOpt = (description: string) => T.Optional(T.String({ description }));

// Matches the Zig per-call deadline (CALL_TIMEOUT_MS in src/browser.zig).
// The pi.exec timeout runs 10s longer so a slow call surfaces as the Zig
// deadline's clean "TimedOut" envelope instead of a pi.exec kill.
const CALL_TIMEOUT_MS = 120000;

// Per-process browser session (tab). Defaults to the shared "pi-main" tab
// every pi process joins; browser_pick_session changes it for the rest of
// this pi process. Module-level glue state survives /new /resume /fork and
// resets on a pi reload (fresh module instance).
let currentSession = "pi-main";

const badSession = (s: string) => !/^[A-Za-z0-9._-]+$/.test(s);

// name: tool name exposed to the model. mcp: lightpanda MCP tool behind it.
// params are passed through as-is, so keys must match the MCP argument names.
const TOOLS: { name: string; mcp?: string; description: string; params: TProperties }[] = [
  { name: "browser_open", mcp: "goto", description: "Navigate to a URL. The page stays loaded for later browser_* calls. Backed by lightpanda, a headless browser engine, not Chrome: no visible window, no screenshots, no vision, no Chrome-only features. Inspect and interact through the DOM tools only.",
    params: { url: T.String({ description: "The URL to navigate to." }), waitUntil: enumOpt(["load", "domcontentloaded", "networkalmostidle", "networkidle", "done"], "Event that completes navigation. Default 'load'. Prefer 'domcontentloaded' + browser_wait_selector on ad-heavy pages."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_read", mcp: "markdown", description: "Read the current page (or a url/selector) as token-efficient markdown. The primary way to see page content in this headless browser, never expect a screenshot.",
    params: { url: strOpt("Optional URL to navigate to before reading."), selector: strOpt("Optional CSS selector; read only that element's subtree."), backendNodeId: intOpt("Optional node id; read only that subtree."), maxBytes: intOpt("Soft cap on output size in bytes."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_html", mcp: "html", description: "Get the raw serialized HTML of the page (or a node/selector).",
    params: { url: strOpt("Optional URL to navigate to first."), selector: strOpt("Optional CSS selector; dump only that element's outerHTML."), backendNodeId: intOpt("Optional node id; dump only that node's outerHTML."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_tree", mcp: "tree", description: "Semantic DOM tree (role, name, value, backendNodeId per node). Best starting point for an unfamiliar page: the DOM is the only view of the page, so never look for screenshots or a visible browser.",
    params: { url: strOpt("Optional URL to navigate to first."), maxDepth: intOpt("Maximum tree depth; start shallow."), backendNodeId: intOpt("Optional node id; tree for that element only."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_links", mcp: "links", description: "Extract all links from the loaded page as absolute URLs, one per line.",
    params: { url: strOpt("Optional URL to navigate to first."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_click", mcp: "click", description: "Click an element by CSS selector or backendNodeId. Returns the resulting URL and title. Clicks target DOM nodes, not pixels, since the browser is headless.",
    params: { selector: strOpt("CSS selector of the element to click. Preferred."), backendNodeId: intOpt("Node id of the element to click.") } },
  { name: "browser_fill", mcp: "fill", description: "Fill text into an input element by CSS selector or backendNodeId.",
    params: { selector: strOpt("CSS selector of the input. Preferred."), backendNodeId: intOpt("Node id of the input."), value: T.String({ description: "The text to fill." }) } },
  { name: "browser_press", mcp: "press", description: "Press a keyboard key (e.g. 'Enter', 'Tab', 'a'), optionally targeted at an element.",
    params: { key: T.String({ description: "The key to press." }), selector: strOpt("Optional CSS selector of the target element."), backendNodeId: intOpt("Optional node id of the target element.") } },
  { name: "browser_scroll", mcp: "scroll", description: "Scroll the window or a specific element. Returns the scroll position.",
    params: { x: intOpt("Horizontal scroll offset."), y: intOpt("Vertical scroll offset."), backendNodeId: intOpt("Optional node id of the element to scroll.") } },
  { name: "browser_hover", mcp: "hover", description: "Hover over an element, triggering mouseover/mouseenter events.",
    params: { selector: strOpt("CSS selector of the element. Preferred."), backendNodeId: intOpt("Node id of the element.") } },
  { name: "browser_select", mcp: "selectOption", description: "Select an option in a <select> dropdown by value.",
    params: { selector: strOpt("CSS selector of the <select>. Preferred."), backendNodeId: intOpt("Node id of the <select>."), value: T.String({ description: "The option value to select." }) } },
  { name: "browser_check", mcp: "setChecked", description: "Check or uncheck a checkbox or radio input.",
    params: { selector: strOpt("CSS selector of the input. Preferred."), backendNodeId: intOpt("Node id of the input."), checked: T.Optional(T.Boolean({ description: "Check (true) or uncheck (false). Default true." })) } },
  { name: "browser_evaluate", mcp: "evaluate", description: "Run JavaScript in the page and return the result as a string.",
    params: { script: T.String({ description: "JS expression or statement; its value is returned." }), url: strOpt("Optional URL to navigate to first."), save: strOpt("Bridge-store key; the result is re-exposed as lp.<name> to later evaluates."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_wait_selector", mcp: "waitForSelector", description: "Wait until an element matching a CSS selector appears. Returns its backendNodeId.",
    params: { selector: T.String({ description: "The CSS selector to wait for." }), timeout: intOpt("Timeout in ms. Default 5000.") } },
  { name: "browser_wait_script", mcp: "waitForScript", description: "Wait until a JS expression evaluates truthy.",
    params: { script: T.String({ description: "JS expression (not a statement) re-evaluated until truthy." }), timeout: intOpt("Timeout in ms. Default 5000.") } },
  { name: "browser_wait_state", mcp: "waitForState", description: "Wait for the page to reach a load state.",
    params: { state: StringEnum(["load", "domcontentloaded", "networkalmostidle", "networkidle", "done"], { description: "Load state to wait for. 'networkidle' is the usual choice for dynamic pages." }), timeout: intOpt("Timeout in ms. Default 5000.") } },
  { name: "browser_extract", mcp: "extract", description: "Extract structured data from the page using a schema mapping field names to CSS-selector specs.",
    params: { schema: T.String({ description: "JSON object literal mapping output field names to CSS-selector specs, e.g. {\"title\":\"h1\",\"price\":\".price\"}." }), save: strOpt("Bridge-store key for later evaluates.") } },
  { name: "browser_structured", mcp: "structuredData", description: "Extract structured data (JSON-LD, OpenGraph, etc) from the loaded page.",
    params: { url: strOpt("Optional URL to navigate to first."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_forms", mcp: "detectForms", description: "Detect all forms on the page with fields, types, and required status.",
    params: { url: strOpt("Optional URL to navigate to first."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_interactive", mcp: "interactiveElements", description: "Extract interactive elements (buttons, links, inputs, etc) from the page.",
    params: { url: strOpt("Optional URL to navigate to first."), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_node", mcp: "nodeDetails", description: "Get details for a node by backendNodeId, including a ready-to-use CSS selector.",
    params: { backendNodeId: T.Integer({ description: "The backend node ID." }) } },
  { name: "browser_find", mcp: "findElement", description: "Find interactive elements by ARIA role and/or accessible name. Returns backend node IDs.",
    params: { role: strOpt("ARIA role to match (e.g. 'button', 'link', 'textbox')."), name: strOpt("Accessible name substring to match (case-insensitive).") } },
  { name: "browser_console", mcp: "consoleLogs", description: "Get buffered console.log/warn/error messages from the current page, then clear the buffer.",
    params: {} },
  { name: "browser_cookies", mcp: "getCookies", description: "Get cookies stored in the browser.",
    params: { url: strOpt("Restrict to cookies matching this URL's host. Defaults to the current page."), all: T.Optional(T.Boolean({ description: "Dump every cookie regardless of host." })) } },
  { name: "browser_url", mcp: "getUrl", description: "Get the URL of the page currently loaded in the browser.",
    params: {} },
  { name: "browser_search", mcp: "search", description: "Run a web search and return the results as markdown.",
    params: { query: T.String({ description: "The search query." }), timeout: intOpt("Timeout in ms. Default 10000.") } },
  { name: "browser_pick_session", description: "Point this pi process at a different browser session (tab) for all later browser_* calls. The browser normally uses the shared session 'pi-main' (one tab every pi process joins). Picking a brand-new name opens a fresh tab, picking a name that already exists (see browser_sessions) joins that tab (e.g. to share one page between pi processes), and picking 'pi-main' returns to the shared tab. The choice sticks for the rest of this pi process and resets on a pi reload.",
    params: { session: T.String({ description: "Session id to use (letters, digits, '-', '_', '.'). Existing ids are listed by browser_sessions." }) } },
  { name: "browser_sessions", mcp: "session_list", description: "List every browser session (tab) currently open in the lightpanda daemon with the URL it holds. Use to see how many tabs exist and what each is showing, and to find a session id to pick (browser_pick_session) or close (browser_close_session).",
    params: {} },
  { name: "browser_close_session", mcp: "session_close", description: "Close a browser session (tab) by its session id, freeing the page it held. See browser_sessions for open ids. A closed session is recreated empty on its next use, so closing 'pi-main' and then using it again resets the shared tab. The permanent empty 'default' catch-all cannot be closed and is never used by the extension, ignore it.",
    params: { session: T.String({ description: "Session id to close, e.g. 'pi-main' or a name from browser_sessions." }) } },
];

export default function (pi: ExtensionAPI) {
  for (const t of TOOLS) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: T.Object(t.params),
      async execute(_toolCallId, params, signal) {
        try {
          const isSessionTool = t.name === "browser_pick_session" || t.name === "browser_close_session";
          const sessionArg = String(params.session);
          if (isSessionTool && badSession(sessionArg)) {
            return toolError(`invalid session id "${sessionArg}" (use letters, digits, '-', '_', or '.')`);
          }
          // browser_pick_session is glue-only: it points this pi process at
          // a different session (tab) for every later browser call.
          if (t.name === "browser_pick_session") {
            currentSession = sessionArg;
            return { content: [{ type: "text" as const, text: `Browser session set to "${sessionArg}" for this pi process. The next browser_* call uses it. Use browser_sessions to list tabs.` }], details: {} };
          }
          // browser_close_session takes the session id as the MCP "id" arg;
          // every other tool passes params through as-is. Lightpanda rejects
          // closing the session the request is attached to, so close calls
          // attach to the permanent empty "default" session instead (never
          // the close target; the server rejects closing default itself).
          const args = t.name === "browser_close_session" ? { id: sessionArg } : params;
          const sess = t.name === "browser_close_session" ? "default" : currentSession;
          // Esc aborts via pi.exec SIGTERM on the one-shot binary. The daemon
          // keeps the page and the in-flight MCP call finishes on its own, so
          // the next call just queues behind it (lightpanda serializes calls
          // per session).
          const res = await callZig(
            pi,
            "pi-browser",
            { op: t.mcp ?? t.name, params: JSON.stringify(args), session: sess },
            { signal, timeout: CALL_TIMEOUT_MS + 10000 },
          );
          return { content: [{ type: "text" as const, text: res.result }], details: {} };
        } catch (e) {
          return toolError(e instanceof Error ? e.message : String(e));
        }
      },
    });
  }
}
