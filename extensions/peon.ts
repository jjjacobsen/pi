// pi-peon: Warcraft peon/peasant sound notifications on pi lifecycle events.
//
// Thin TS: wires pi events and the /peon settings panel to the Zig backend
// (src/peon.zig), which owns every decision: when a sound plays, which
// sound (randomly from both the orc peon and human peasant packs), the
// volume, and the afplay spawn. This file only moves events and settings
// between pi and the backend. It replaces the third-party pi-peon-ping
// extension: no pack picker, no relay, no desktop notifications, no preview
// sound, and no input.required / resource.limit categories (pi has no events
// for those).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { createBackend, handleSessionShutdown } from "./lib/backend";

const backend = createBackend("pi-peon", {
  onOk: (msg) => msg.config, // resolve the config op with its config payload
  onError: (msg) => msg.error ?? "peon backend error",
});

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
    backend.call("event", { event: "session_start", reason: event.reason }).catch(() => {});
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    backend.call("event", { event: "agent_start" }).catch(() => {});
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!ctx.hasUI || !event.isError) return;
    backend.call("event", { event: "tool_error" }).catch(() => {});
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    backend.call("event", { event: "agent_end", error: lastStopReason(event.messages) === "error" }).catch(() => {});
  });
}

function registerPeonCommand(pi) {
  pi.registerCommand("peon", {
    description: "peon-ping sound settings",
    handler: async (_args, ctx) => {
      let config;
      try {
        config = await backend.call("config");
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
            backend.call("set", { field: id, value: newValue }).catch(() => {});
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
  pi.on("session_shutdown", (event) => handleSessionShutdown(backend, event));
  registerLifecycle(pi);
  registerPeonCommand(pi);
}
