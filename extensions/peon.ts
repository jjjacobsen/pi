// pi-peon: Warcraft peon/peasant sound notifications on pi lifecycle events.
//
// Thin TS: wires pi events and the /peon settings panel to the Zig backend
// (src/peon.zig), which owns every decision: when a sound plays, which
// sound (randomly from both the orc peon and human peasant packs), the
// volume, and the afplay spawn. The backend is a one-shot child: each call
// spawns pi-peon with the request as one JSON argv element (shared callZig
// helper), gets one JSON envelope back, and exits. Backend counters (spam
// ring, debounce, last played, the running afplay's pid) round-trip through
// peon-state.json in the agent dir, so event calls are serialized here
// through a promise chain: two back-to-back events must not interleave
// their state read/write.
//
// This file only moves events and settings between pi and the backend. It
// replaces the third-party pi-peon-ping extension: no pack picker, no relay,
// no desktop notifications, no preview sound, and no input.required /
// resource.limit categories (pi has no events for those).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { callZig } from "./lib/zig";

const EVENT_TIMEOUT_MS = 10000;

// Event calls are one-shot spawns that read and rewrite peon-state.json, so
// back-to-back events must run one at a time (the old persistent backend
// serialized them on its pipe for free). Chain every event call on this
// promise; a failed call must not stall the chain.
let eventQueue = Promise.resolve();

function fireEvent(pi, event, extra = {}) {
  eventQueue = eventQueue.then(() =>
    callZig(pi, "pi-peon", { op: "event", event, ...extra, agent_dir: getAgentDir() }, { timeout: EVENT_TIMEOUT_MS }).catch(() => {}),
  );
}

const CATEGORY_LABELS = [
  ["session.start", "Session start"],
  ["task.acknowledge", "Task acknowledge"],
  ["task.complete", "Task complete"],
  ["task.error", "Task error"],
  ["user.spam", "Rapid prompt spam"],
];

const VOLUME_STEPS = ["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"];
const SILENT_WINDOW_STEPS = ["0s", "1s", "2s", "3s", "5s", "10s", "15s", "30s"];

// stopReason of the last assistant message in a run (agent_end payload).
// An "error" stop reason means the run failed; peon must not play the
// cheerful task.complete sound for it.
function lastStopReason(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

function registerLifecycle(pi) {
  pi.on("session_start", (event, ctx) => {
    if (!ctx.hasUI) return;
    fireEvent(pi, "session_start", { reason: event.reason });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    fireEvent(pi, "agent_start");
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!ctx.hasUI || !event.isError) return;
    fireEvent(pi, "tool_error");
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    fireEvent(pi, "agent_end", { error: lastStopReason(event.messages) === "error" });
  });
}

function registerPeonCommand(pi) {
  pi.registerCommand("peon", {
    description: "peon-ping sound settings",
    handler: async (_args, ctx) => {
      let config;
      try {
        // The config op carries the config serialized in its result text.
        const res = await callZig(pi, "pi-peon", { op: "config", agent_dir: getAgentDir() }, { timeout: EVENT_TIMEOUT_MS });
        config = JSON.parse(res.result);
      } catch (err) {
        return ctx.ui.notify(`peon: ${err?.message ?? err}`, "error");
      }

      const items: SettingItem[] = [
        {
          id: "paused",
          label: "Sounds",
          currentValue: config.paused ? "paused" : "active",
          values: ["active", "paused"],
        },
        {
          id: "volume",
          label: "Volume",
          currentValue: `${config.volume}%`,
          values: VOLUME_STEPS,
        },
        {
          id: "silent_window_seconds",
          label: "Silent window",
          description: "Suppress task complete for runs shorter than N seconds",
          currentValue: `${config.silent_window_seconds}s`,
          values: SILENT_WINDOW_STEPS,
        },
      ];
      for (const [cat, label] of CATEGORY_LABELS) {
        items.push({
          id: `cat:${cat}`,
          label,
          currentValue: config.categories[cat] ? "on" : "off",
          values: ["on", "off"],
        });
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Peon ping")), 1, 1));

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            callZig(pi, "pi-peon", { op: "set", field: id, value: newValue, agent_dir: getAgentDir() }, { timeout: EVENT_TIMEOUT_MS }).catch(() => {});
          },
          () => done(undefined),
        );
        container.addChild(settingsList);

        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerLifecycle(pi);
  registerPeonCommand(pi);
}
