// pi-cua: thin TypeScript glue for the Zig computer-use backend.
//
// pi extensions must be TypeScript modules, so this file registers the
// computer_* tool schemas and calls src/cua.zig as a one-shot process: the
// request travels as one JSON argv element via pi.exec (shared callZig
// helper), the binary prints one JSON envelope to stdout and exits. All
// driver logic lives in Zig, which spawns `cua-driver call <tool> <json-args>`
// per call against the CuaDriver daemon (https://github.com/trycua/cua).
//
// Visual tools are inactive by default and toggled for the current extension
// runtime with /visual-tools. While off, screenshot and coordinate-only tools
// are absent from the model context, mixed action schemas expose only AX
// targeting, and get_window_state omits its screenshot path.
//
// Protocol:
//   -> {"op":"call","agent_dir":"...","tool":"get_window_state","params":"{\"pid\":123}"}   params is a JSON string
//   <- {"ok":true,"result":"..."} | {"ok":false,"error":"..."}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type TProperties } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { callZig } from "./lib/zig";
import { toolError } from "./lib/toolkit";

const T = Type;
const enumOpt = (values: string[], description: string) =>
  T.Optional(StringEnum(values, { description }));
const intOpt = (description: string) => T.Optional(T.Integer({ description }));
const numOpt = (description: string) => T.Optional(T.Number({ description }));
const strOpt = (description: string) => T.Optional(T.String({ description }));

// Matches the Zig per-call deadline (CALL_TIMEOUT_MS in src/cua.zig). The
// pi.exec timeout runs 10s longer so a slow call surfaces as the Zig
// deadline's clean "TimedOut" envelope instead of a pi.exec kill.
const CALL_TIMEOUT_MS = 120000;

// Shared schema fragments: every element-addressed action accepts the same
// targeting fields, so the model learns one addressing pattern. Prefer
// element_token (self-validating, carries the snapshot) or element_index +
// snapshot_id from the latest computer_get_window_state; x/y are
// window-local screenshot pixels (top-left origin, 2x scale on retina) for
// canvas/video/WebGL surfaces only.
const target = {
  pid: T.Integer({ description: "Target process ID from computer_list_apps." }),
  window_id: intOpt("CGWindowID from computer_list_windows. Required when element_index is used; optional when element_token carries it."),
  element_index: intOpt("Element index from the latest computer_get_window_state. Requires snapshot_id. The AX path works on backgrounded/hidden windows with no focus steal."),
  element_token: strOpt("Opaque per-snapshot element handle from computer_get_window_state. Preferred: identifies one exact element and goes stale with an explicit error after a re-snapshot."),
  snapshot_id: strOpt("Snapshot handle from computer_get_window_state. Required when targeting by element_index; stale snapshots fail closed."),
};

// name: tool name exposed to the model. mcp: cua-driver MCP tool behind it.
// params are passed through as-is, so keys must match the MCP argument
// names (verified against `cua-driver describe`).
const TOOLS: { name: string; mcp?: string; description: string; params: TProperties; visualOnly?: boolean; semanticDescription?: string; semanticParams?: TProperties }[] = [
  { name: "computer_list_apps", mcp: "list_apps", description: "List macOS apps (running and installed-but-not-running) with pid, bundle_id, and window state. Start here to find what is open.",
    params: {} },
  { name: "computer_list_windows", mcp: "list_windows", description: "List all layer-0 top-level windows with window_id, bounds, and owner pid. Use to find a window's window_id and to check what is on screen.",
    params: { pid: intOpt("Optional pid filter; only this pid's windows are returned."), on_screen_only: T.Optional(T.Boolean({ description: "When true, drop windows not on the current Space. Default false." })) } },
  { name: "computer_get_screen_size", mcp: "get_screen_size", description: "Return the logical size of the main display in points plus its backing scale factor.", visualOnly: true,
    params: {} },
  { name: "computer_get_accessibility_tree", mcp: "get_accessibility_tree", description: "Lightweight desktop snapshot: running regular apps and on-screen visible windows with bounds, z-order, and owner pid. Cheaper than computer_list_windows + computer_get_window_state when you only need an overview. Prefer tree-based tools like this over screenshots.",
    params: {} },
  { name: "computer_get_cursor_position", mcp: "get_cursor_position", description: "Return the current mouse cursor position in screen points (origin top-left).", visualOnly: true,
    params: {} },
  { name: "computer_screenshot", mcp: "get_desktop_state", description: "Capture the full display in true screen pixels (no downscale). Saves a PNG to disk and returns its path; call describe_image on the path to actually see the screen (the primary model is text-only). Last resort only: use the AX tree (computer_get_accessibility_tree, computer_get_window_state) first and screenshot only when it cannot answer, since vision tokens are expensive.", visualOnly: true,
    params: {} },
  { name: "computer_get_window_state", mcp: "get_window_state", description: "Snapshot one window as an AX element tree with [element_index N] tags (the model-facing form of the same rows computer_click/type_text/etc. address). Always start here: the tree is the primary interface and needs no vision. A screenshot is also saved to disk (its path is in the result; view with describe_image) but use it only as a last resort when the tree is missing or unreliable, e.g. Electron or Catalyst surfaces. Re-snapshot every turn before acting: indices and element_tokens go stale the moment the window changes. Pass query to filter a huge tree.",
    semanticDescription: "Snapshot one window as an AX element tree with [element_index N] tags (the model-facing form of the same rows computer_click/type_text/etc. address). Always start here: the tree is the primary interface. Re-snapshot every turn before acting because indices and element_tokens go stale when the window changes. Pass query to filter a huge tree.",
    params: { pid: T.Integer({ description: "Target process ID from computer_list_apps." }), window_id: T.Integer({ description: "CGWindowID from computer_list_windows." }), query: strOpt("Case-insensitive filter for the tree; returns matching rows plus their ancestor chain without renumbering element_index values."), max_elements: intOpt("Cap on AX nodes walked (default 2000). Lower for Electron/Obsidian apps with 10k+ element trees to avoid context blow-up."), max_depth: intOpt("Cap on AX-tree depth (default 25).") } },
  { name: "computer_zoom", mcp: "zoom", description: "Crop a window region (x1,y1)-(x2,y2) in screenshot pixels to a JPEG at most 500px wide, saved to disk with its path returned. Call describe_image on the path to read text or inspect pixels at readable size. Click/type coordinates taken from a zoom image translate back to full-window space automatically. Only use once a screenshot is already justified, never instead of the AX tree.", visualOnly: true,
    params: { pid: T.Integer({ description: "Target process ID (needed for coordinate translation)." }), window_id: T.Integer({ description: "CGWindowID from computer_list_windows." }), x1: T.Number({ description: "Left edge of the region in screenshot pixels." }), y1: T.Number({ description: "Top edge of the region in screenshot pixels." }), x2: T.Number({ description: "Right edge of the region in screenshot pixels." }), y2: T.Number({ description: "Bottom edge of the region in screenshot pixels." }) } },
  { name: "computer_click", mcp: "click", description: "Click. Prefer element_token or element_index + snapshot_id from the latest computer_get_window_state: the AX path works on backgrounded/minimized windows without moving the cursor or stealing focus. Use x/y pixel coordinates (window-local screenshot pixels) only for canvas/video/WebGL surfaces that do not appear in the AX tree. delivery_mode 'foreground' briefly fronts the window (last resort). Modified clicks (modifier) require delivery_mode 'foreground'.",
    semanticDescription: "Click an AX element identified by element_token or element_index + snapshot_id from the latest computer_get_window_state. The AX path works on backgrounded or minimized windows without moving the cursor or stealing focus.",
    semanticParams: { ...target, action: enumOpt(["press", "show_menu", "pick", "confirm", "cancel", "open"], "AX action. Default press."), modifier: T.Optional(T.Array(T.String({ description: "Modifier keys held during the click: cmd, shift, option, ctrl." }))), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal. Foreground briefly fronts the window and restores the prior frontmost; use only when a background attempt did not land.") },
    params: { ...target, x: numOpt("X in window-local screenshot pixels (pixel path; must come with y)."), y: numOpt("Y in window-local screenshot pixels."), button: enumOpt(["left", "right", "middle"], "Mouse button. Default left."), action: enumOpt(["press", "show_menu", "pick", "confirm", "cancel", "open"], "AX action. Default press."), count: intOpt("Click count (pixel path only). Default 1."), modifier: T.Optional(T.Array(T.String({ description: "Modifier keys held during the click: cmd, shift, option, ctrl." }))), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal. Foreground briefly fronts the window and restores the prior frontmost; use only when a background attempt did not land.") } },
  { name: "computer_double_click", mcp: "double_click", description: "Double-click at (x, y) or on an AX element identified by element_index + snapshot_id (or element_token). Same addressing rules as computer_click.",
    semanticDescription: "Double-click an AX element identified by element_token or element_index + snapshot_id from the latest computer_get_window_state.",
    semanticParams: { ...target, delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal.") },
    params: { ...target, x: numOpt("X in window-local screenshot pixels (pixel path; must come with y)."), y: numOpt("Y in window-local screenshot pixels."), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal.") } },
  { name: "computer_right_click", mcp: "right_click", description: "Right-click. Same addressing rules as computer_click; the AX path maps to AXShowMenu on the element.",
    semanticDescription: "Right-click an AX element identified by element_token or element_index + snapshot_id from the latest computer_get_window_state. The AX path maps to AXShowMenu on the element.",
    semanticParams: { ...target, delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal.") },
    params: { ...target, x: numOpt("X in window-local screenshot pixels (pixel path; must come with y)."), y: numOpt("Y in window-local screenshot pixels."), modifier: T.Optional(T.Array(T.String({ description: "Modifier keys held during the right-click: cmd, shift, option, ctrl. Pixel path only." }))), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal.") } },
  { name: "computer_type_text", mcp: "type_text", description: "Insert text at the target's cursor. Native controls are confirmed via AXValue read-back; web-content writes return effect unverifiable, so verify with a fresh computer_get_window_state. Re-call with delivery_mode 'foreground' when a background attempt remains unverifiable and a fresh snapshot shows the text did not appear.",
    params: { ...target, text: T.String({ description: "The text to insert." }), delay_ms: intOpt("Milliseconds between characters in the CGEvent fallback path. Default 30, max 200."), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal."), scope: enumOpt(["window", "desktop"], "Default window. Use desktop with no pid/window_id to type into the frontmost application.") } },
  { name: "computer_press_key", mcp: "press_key", description: "Press and release a single key (return, tab, escape, up, down, etc.), optionally with modifiers, at the target.",
    params: { ...target, key: T.String({ description: "Key name: return, tab, escape, up, down, etc." }), modifiers: T.Optional(T.Array(T.String({ description: "Modifier keys: cmd, shift, option/alt, ctrl, fn." }))), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal."), scope: enumOpt(["window", "desktop"], "Default window. Use desktop with no pid/window_id to send the key to the frontmost application.") } },
  { name: "computer_hotkey", mcp: "hotkey", description: "Press a key combination, e.g. [\"cmd\", \"c\"]. At least two keys: modifier(s) plus one non-modifier.",
    params: { ...target, keys: T.Array(T.String({ description: "Modifier(s) and one non-modifier key, e.g. [\"cmd\", \"c\"]." }), { minItems: 2 }), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal."), scope: enumOpt(["window", "desktop"], "Default window. Use desktop with no pid/window_id to send the chord to the frontmost application.") } },
  { name: "computer_scroll", mcp: "scroll", description: "Scroll the target window up/down/left/right, by line or page.",
    params: { ...target, direction: StringEnum(["up", "down", "left", "right"], { description: "Scroll direction." }), by: enumOpt(["line", "page"], "Scroll granularity. Default line."), amount: intOpt("Number of wheel notches (pixel path) or keystroke repetitions. Default 3, max 50."), delivery_mode: enumOpt(["background", "foreground"], "Default background: no focus steal."), scope: enumOpt(["window", "desktop"], "Default window. Use desktop with x,y and no pid/window_id for get_desktop_state screenshot coordinates.") } },
  { name: "computer_move_cursor", mcp: "move_cursor", description: "Move the agent cursor to (x, y).", visualOnly: true,
    params: { x: T.Number({ description: "X coordinate." }), y: T.Number({ description: "Y coordinate." }), scope: enumOpt(["window", "desktop"], "Default window."), cursor_id: strOpt("Cursor instance to move. Default 'default'.") } },
  { name: "computer_launch_app", mcp: "launch_app", description: "Launch a macOS app (backgrounded: it does NOT come to the foreground). Prefer bundle_id over name.",
    params: { bundle_id: strOpt("App bundle identifier, e.g. com.apple.calculator. Preferred over name."), name: strOpt("App display name. Used only when bundle_id is absent."), urls: T.Optional(T.Array(T.String({ description: "Optional file paths or URLs to open with the app (e.g. a folder path for Finder)." }))), additional_arguments: T.Optional(T.Array(T.String({ description: "Extra arguments appended after --args when launching." }))) } },
  { name: "computer_bring_to_front", mcp: "bring_to_front", description: "Persistently activate an app (or a specific window of it) and leave it in the foreground.",
    params: { pid: T.Integer({ description: "Target process ID." }), window_id: intOpt("Optional window to bring to front.") } },
  { name: "computer_kill_app", mcp: "kill_app", description: "Force-terminate a process by pid (kill -9 equivalent). Use only when a normal quit is not possible.",
    params: { pid: T.Integer({ description: "PID of the process to terminate." }) } },
];

const VISUAL_TOOL_NAMES = new Set(TOOLS.filter((t) => t.visualOnly).map((t) => t.name));
const MIXED_TOOLS = TOOLS.filter((t) => t.semanticDescription || t.semanticParams);

function stripScreenshotPath(text) {
  return text.split("\n").filter((line) => !line.startsWith("screenshot: ")).join("\n");
}

export default function cuaExtension(pi: ExtensionAPI) {
  let visualToolsEnabled = false;

  function registerTool(t, visual) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: !visual && t.semanticDescription ? t.semanticDescription : t.description,
      parameters: T.Object(!visual && t.semanticParams ? t.semanticParams : t.params),
      async execute(_toolCallId, params, signal) {
        // Esc aborts via pi.exec SIGTERM on the one-shot binary; the
        // in-flight `cua-driver call` is short-lived and finishes on its
        // own (matching vision/search abort semantics).
        try {
          const res = await callZig(
            pi,
            "pi-cua",
            { op: "call", agent_dir: getAgentDir(), tool: t.mcp, params: JSON.stringify(params) },
            { signal, timeout: CALL_TIMEOUT_MS + 10000 },
          );
          const text = !visual && t.name === "computer_get_window_state"
            ? stripScreenshotPath(res.result)
            : res.result;
          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (e) {
          return toolError(e instanceof Error ? e.message : String(e));
        }
      },
    });
  }

  function setVisualTools(enabled) {
    if (enabled !== visualToolsEnabled) {
      for (const t of MIXED_TOOLS) registerTool(t, enabled);
      visualToolsEnabled = enabled;
    }

    const active = pi.getActiveTools().filter((name) => !VISUAL_TOOL_NAMES.has(name));
    pi.setActiveTools(enabled ? [...new Set([...active, ...VISUAL_TOOL_NAMES])] : active);
  }

  for (const t of TOOLS) registerTool(t, false);

  pi.on("session_start", () => {
    setVisualTools(false);
  });

  pi.registerCommand("visual-tools", {
    description: "Toggle screenshot and pixel-coordinate computer tools for this session",
    handler: async (_args, ctx) => {
      setVisualTools(!visualToolsEnabled);
      ctx.ui.notify(`Visual tools ${visualToolsEnabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
