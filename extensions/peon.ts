// pi-peon: Warcraft peon/peasant sound notifications on pi lifecycle events
// Adapted from https://github.com/joshuadavidthomas/pi-peon-ping

import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

const MAX_PROMPT_TRACK = 16;
const DEBOUNCE_MS = 5000;
const ASSET_DIR = path.resolve(import.meta.dirname, "../assets/peon");

const CATEGORY_LABELS = [
  ["session.start", "Session start"],
  ["task.acknowledge", "Task acknowledge"],
  ["task.complete", "Task complete"],
  ["task.error", "Task error"],
  ["user.spam", "Rapid prompt spam"],
];

const SOUNDS = {
  "session.start": [
    "PeasantReady1.wav",
    "PeasantWhat1.wav",
    "PeasantWhat2.wav",
    "PeonReady1.wav",
    "PeonWhat1.wav",
    "PeonWhat3.wav",
  ],
  "task.acknowledge": [
    "PeasantYes1.wav",
    "PeasantYes2.wav",
    "PeasantYes3.wav",
    "PeasantYes4.wav",
    "PeasantYesAttack1.wav",
    "PeasantYesAttack2.wav",
    "PeonYes1.wav",
    "PeonYes2.wav",
    "PeonYes3.wav",
    "PeonYes4.wav",
    "PeonYesAttack1.wav",
    "PeonYesAttack2.wav",
    "PeonYesAttack3.wav",
  ],
  "task.complete": [
    "PeasantReady1.wav",
    "PeasantWhat3.wav",
    "PeasantYes1.wav",
    "PeasantYes3.wav",
    "PeonReady1.wav",
    "PeonWhat4.wav",
    "PeonYes1.wav",
    "PeonYes2.wav",
    "PeonYes3.wav",
    "PeonYesAttack1.wav",
    "PeonYesAttack3.wav",
  ],
  "task.error": ["PeasantYesAttack3.wav", "PeasantYesAttack4.wav", "PeonAngry4.wav", "PeonDeath.wav"],
  "user.spam": [
    "PeasantAngry1.wav",
    "PeasantAngry2.wav",
    "PeasantAngry3.wav",
    "PeasantAngry4.wav",
    "PeasantAngry5.wav",
    "PeonAngry1.wav",
    "PeonAngry2.wav",
    "PeonAngry3.wav",
  ],
};

const VOLUME_STEPS = ["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"];
const SILENT_WINDOW_STEPS = ["0s", "1s", "2s", "3s", "5s", "10s", "15s", "30s"];

function defaultConfig() {
  return {
    volume: 50,
    paused: false,
    silent_window_seconds: 0,
    annoyed_threshold: 3,
    annoyed_window_seconds: 10,
    categories: {
      "session.start": true,
      "task.acknowledge": true,
      "task.complete": true,
      "task.error": true,
      "user.spam": true,
    },
  };
}

function defaultState() {
  return {
    last_played: Array(5).fill(null),
    timestamps: Array(MAX_PROMPT_TRACK).fill(0),
    timestamp_count: 0,
    timestamp_head: 0,
    last_agent_start: 0,
    last_stop_time: 0,
  };
}

const CATEGORY_INDEX = Object.fromEntries(Object.keys(SOUNDS).map((category, index) => [category, index]));
let afplay;

function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value;
}

function field(value, name, fallback) {
  return value[name] === undefined ? fallback : value[name];
}

function integer(value, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("expected integer");
  return value;
}

function normalizeConfig(value) {
  value = object(value);
  const defaults = defaultConfig();
  const categories = value.categories === undefined ? {} : object(value.categories);
  const config = {
    volume: field(value, "volume", defaults.volume),
    paused: field(value, "paused", defaults.paused),
    silent_window_seconds: field(value, "silent_window_seconds", defaults.silent_window_seconds),
    annoyed_threshold: field(value, "annoyed_threshold", defaults.annoyed_threshold),
    annoyed_window_seconds: field(value, "annoyed_window_seconds", defaults.annoyed_window_seconds),
    categories: Object.fromEntries(
      Object.keys(defaults.categories).map((category) => [category, field(categories, category, defaults.categories[category])]),
    ),
  };
  integer(config.volume, 0, 255);
  integer(config.silent_window_seconds);
  integer(config.annoyed_threshold);
  integer(config.annoyed_window_seconds);
  if (typeof config.paused !== "boolean") throw new Error("invalid config");
  if (Object.values(config.categories).some((enabled) => typeof enabled !== "boolean")) throw new Error("invalid config");
  return config;
}

function normalizeState(value) {
  value = object(value);
  const defaults = defaultState();
  const state = {
    last_played: field(value, "last_played", defaults.last_played),
    timestamps: field(value, "timestamps", defaults.timestamps),
    timestamp_count: field(value, "timestamp_count", defaults.timestamp_count),
    timestamp_head: field(value, "timestamp_head", defaults.timestamp_head),
    last_agent_start: field(value, "last_agent_start", defaults.last_agent_start),
    last_stop_time: field(value, "last_stop_time", defaults.last_stop_time),
  };
  if (!Array.isArray(state.last_played) || state.last_played.length !== 5) throw new Error("invalid state");
  if (!Array.isArray(state.timestamps) || state.timestamps.length !== MAX_PROMPT_TRACK) throw new Error("invalid state");
  for (const item of state.last_played) if (item !== null) integer(item, 0, 0xffffffff);
  for (const item of state.timestamps) integer(item);
  integer(state.timestamp_count, 0, MAX_PROMPT_TRACK);
  integer(state.timestamp_head, 0, MAX_PROMPT_TRACK - 1);
  integer(state.last_agent_start);
  integer(state.last_stop_time);
  return state;
}

async function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(await readFile(path.join(getAgentDir(), "peon.json"), "utf8")));
  } catch (err) {
    if (err?.code !== "ENOENT") console.error(`pi-peon: config load failed (${err?.message ?? err}), using defaults`);
    return defaultConfig();
  }
}

async function loadState() {
  try {
    return normalizeState(JSON.parse(await readFile(path.join(getAgentDir(), "peon-state.json"), "utf8")));
  } catch (err) {
    if (err?.code !== "ENOENT") console.error(`pi-peon: state load failed (${err?.message ?? err}), using defaults`);
    return defaultState();
  }
}

async function saveConfig(config) {
  await writeFile(path.join(getAgentDir(), "peon.json"), `${JSON.stringify(config)}\n`);
}

async function saveState(state) {
  const file = path.join(getAgentDir(), "peon-state.json");
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`);
  await rename(temporary, file).catch(() => {});
}

function parsePercent(value) {
  const match = /^[ \t]*([0-9]+)[ \t]*%[ \t]*$/.exec(value);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(number) || number < 10 || number > 100) throw new Error("set: volume expects 10%..100%");
  return number;
}

function parseSeconds(value) {
  const match = /^[ \t]*([0-9]+)[ \t]*[sS][ \t]*$/.exec(value);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > 3600) {
    throw new Error("set: silent_window_seconds expects 0s..3600s");
  }
  return number;
}

let configQueue = Promise.resolve();

function setConfig(field, value) {
  const pending = configQueue.then(async () => {
    const config = await loadConfig();
    if (field === "paused") {
      if (value !== "active" && value !== "paused") throw new Error("set: paused expects active|paused");
      config.paused = value === "paused";
    } else if (field === "volume") {
      config.volume = parsePercent(value);
    } else if (field === "silent_window_seconds") {
      config.silent_window_seconds = parseSeconds(value);
    } else if (field.startsWith("cat:")) {
      if (value !== "on" && value !== "off") throw new Error("set: category expects on|off");
      const category = field.slice(4);
      if (!(category in config.categories)) throw new Error("set: unknown category");
      config.categories[category] = value === "on";
    } else {
      throw new Error("set: unknown field");
    }
    await saveConfig(config);
  });
  configQueue = pending.catch(() => {});
  return pending;
}

function pickSound(state, category) {
  const sounds = SOUNDS[category];
  const categoryIndex = CATEGORY_INDEX[category];
  const last = state.last_played[categoryIndex];
  let index = Math.floor(Math.random() * sounds.length);
  for (let tries = 0; sounds.length > 1 && last !== null && index === last && tries < 8; tries++) {
    index = Math.floor(Math.random() * sounds.length);
  }
  state.last_played[categoryIndex] = index;
  return sounds[index];
}

function play(config, state, category) {
  if (config.paused || !config.categories[category]) return;
  const sound = pickSound(state, category);

  if (afplay) afplay.kill("SIGTERM");

  const volume = Math.min(Math.max(config.volume, 0), 100) / 100;
  try {
    const child = spawn("afplay", ["-v", String(volume), path.join(ASSET_DIR, sound)], {
      detached: true,
      stdio: "ignore",
    });
    afplay = child;
    child.once("error", (err) => console.error(`pi-peon: afplay spawn failed (${err.message})`));
    child.once("close", () => {
      if (afplay === child) afplay = undefined;
    });
    child.unref();
  } catch (err) {
    console.error(`pi-peon: afplay spawn failed (${err?.message ?? err})`);
  }
}

function pushTimestamp(state, now) {
  if (state.timestamp_count < MAX_PROMPT_TRACK) {
    state.timestamps[(state.timestamp_head + state.timestamp_count) % MAX_PROMPT_TRACK] = now;
    state.timestamp_count++;
  } else {
    state.timestamps[state.timestamp_head] = now;
    state.timestamp_head = (state.timestamp_head + 1) % MAX_PROMPT_TRACK;
  }
}

function countRecent(state, now, windowMs) {
  let count = 0;
  for (let index = 0; index < state.timestamp_count; index++) {
    const timestamp = state.timestamps[(state.timestamp_head + index) % MAX_PROMPT_TRACK];
    const age = now - timestamp;
    if (age >= 0 && age <= windowMs) count++;
  }
  return count;
}

async function handleEvent(event, extra = {}) {
  const config = await loadConfig();
  const state = await loadState();
  const now = Date.now();

  if (event === "session_start") {
    play(config, state, "session.start");
  } else if (event === "agent_start") {
    state.last_agent_start = now;
    pushTimestamp(state, now);
    const threshold = Math.max(config.annoyed_threshold, 1);
    const category = countRecent(state, now, config.annoyed_window_seconds * 1000) >= threshold
      ? "user.spam"
      : "task.acknowledge";
    play(config, state, category);
  } else if (event === "tool_error") {
    play(config, state, "task.error");
  } else if (event === "agent_end" && !extra["error"] && now - state.last_stop_time >= DEBOUNCE_MS) {
    const runMs = now - state.last_agent_start;
    const silentMs = config.silent_window_seconds * 1000;
    if (silentMs <= 0 || runMs < 0 || runMs >= silentMs) {
      state.last_stop_time = now;
      play(config, state, "task.complete");
    }
  }

  try {
    await saveState(state);
  } catch (err) {
    console.error(`pi-peon: state save failed (${err?.message ?? err})`);
  }
}

let eventQueue = Promise.resolve();

function fireEvent(event, extra = {}) {
  eventQueue = eventQueue.then(() => handleEvent(event, extra)).catch(() => {});
}

function lastStopReason(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message.stopReason;
  }
  return undefined;
}

function registerLifecycle(pi) {
  pi.on("session_start", (event, ctx) => {
    if (ctx.hasUI) fireEvent("session_start", { reason: event.reason });
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.hasUI) fireEvent("agent_start");
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.hasUI && event.isError) fireEvent("tool_error");
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.hasUI) fireEvent("agent_end", { error: lastStopReason(event.messages) === "error" });
  });
}

function registerPeonCommand(pi) {
  pi.registerCommand("peon", {
    description: "peon-ping sound settings",
    handler: async (_args, ctx) => {
      const config = await loadConfig();
      const items: SettingItem[] = [
        { id: "paused", label: "Sounds", currentValue: config.paused ? "paused" : "active", values: ["active", "paused"] },
        { id: "volume", label: "Volume", currentValue: `${config.volume}%`, values: VOLUME_STEPS },
        {
          id: "silent_window_seconds",
          label: "Silent window",
          description: "Suppress task complete for runs shorter than N seconds",
          currentValue: `${config.silent_window_seconds}s`,
          values: SILENT_WINDOW_STEPS,
        },
      ];
      for (const [category, label] of CATEGORY_LABELS) {
        items.push({
          id: `cat:${category}`,
          label,
          currentValue: config.categories[category] ? "on" : "off",
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
            setConfig(id, newValue).catch((error) => {
              ctx.ui.notify(`Peon settings save failed: ${error?.message ?? error}`, "error");
            });
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
