// pi-peon: Warcraft peon/peasant sound notifications for pi.
//
// The pi extension (extensions/peon.ts) sends one JSON request per call as a
// single argv element via pi.exec, we answer with one JSON envelope on
// stdout and exit 0/1. The extension owns the pi event wiring and the /peon
// settings panel; this backend owns every decision: when a sound plays,
// which sound, at what volume, and how to play it. The peon and peasant
// sound packs are embedded in the binary (src/peon/sounds.zig), extracted
// to <agent_dir>/peon-sounds/ on every call (idempotent), and played with
// afplay. Config lives in <agent_dir>/peon.json. Cross-call counters live in
// <agent_dir>/peon-state.json (see the State struct).
//
// Request:  {"op":"config","agent_dir":"..."}
//           {"op":"set","field":"volume","value":"75%","agent_dir":"..."}
//           {"op":"set","field":"cat:task.error","value":"on","agent_dir":"..."}
//           {"op":"event","event":"session_start","reason":"startup","agent_dir":"..."}
//           {"op":"event","event":"agent_start","agent_dir":"..."}
//           {"op":"event","event":"tool_error","agent_dir":"..."}
//           {"op":"event","event":"agent_end","error":true,"agent_dir":"..."}
// Response: {"ok":true,"result":"<config json>"} | {"ok":true}
//           {"ok":false,"error":"..."}
//
// Events: session_start (plays session.start on every reason, reload
// included), agent_start (task.acknowledge, or user.spam when prompts arrive
// faster than the spam threshold), tool_error (task.error), agent_end
// (task.complete, gated on the run not ending in error, a debounce, and the
// silent window). Every event is its own process, so the counters that used
// to live in memory now round-trip through peon-state.json: the debounce
// clock, the spam timestamp ring, the last played index per category, and
// the pid of the afplay still running (one sound at a time = read, kill,
// spawn, write).

const std = @import("std");
const mem = std.mem;
const json = std.json;
const posix = std.posix;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const sounds = @import("peon/sounds.zig");
const nowRealtimeMs = common.nowRealtimeMs;
const writeAllIo = common.writeAllIo;
const respondExit = common.respondExit;
const respondOutcomeExit = common.respondOutcomeExit;
const failOutcome = common.failOutcome;

const MAX_PROMPT_TRACK = 16; // ring buffer size for spam detection
const DEBOUNCE_MS = 5000; // min gap between two task.complete sounds

// ---------------------------------------------------------------------------
// Config (<agent_dir>/peon.json)

const Categories = struct {
    @"session.start": bool = true,
    @"task.acknowledge": bool = true,
    @"task.complete": bool = true,
    @"task.error": bool = true,
    @"user.spam": bool = true,

    fn enabled(self: *const Categories, cat: sounds.Category) bool {
        return switch (cat) {
            .session_start => self.@"session.start",
            .task_acknowledge => self.@"task.acknowledge",
            .task_complete => self.@"task.complete",
            .task_error => self.@"task.error",
            .user_spam => self.@"user.spam",
        };
    }

    fn apply(self: *Categories, name: []const u8, on: bool) bool {
        if (mem.eql(u8, name, "session.start")) {
            self.@"session.start" = on;
            return true;
        }
        if (mem.eql(u8, name, "task.acknowledge")) {
            self.@"task.acknowledge" = on;
            return true;
        }
        if (mem.eql(u8, name, "task.complete")) {
            self.@"task.complete" = on;
            return true;
        }
        if (mem.eql(u8, name, "task.error")) {
            self.@"task.error" = on;
            return true;
        }
        if (mem.eql(u8, name, "user.spam")) {
            self.@"user.spam" = on;
            return true;
        }
        return false;
    }
};

const Config = struct {
    volume: u8 = 50, // percent
    paused: bool = false,
    silent_window_seconds: i64 = 0, // suppress task.complete for runs shorter than this
    annoyed_threshold: i64 = 3, // prompts within the window that count as spam
    annoyed_window_seconds: i64 = 10,
    categories: Categories = .{},
};

// ---------------------------------------------------------------------------
// Cross-call state (<agent_dir>/peon-state.json)

// One event per process means nothing survives in memory, so the counters
// that used to be the backend's live state are this struct: the debounce
// clock (last_stop_time), the silent-window baseline (last_agent_start),
// the spam timestamp ring, the last played index per category, and the pid
// of the still-running afplay so the next play can cut it off. Loaded at the
// start of every event op, written atomically after it.
const State = struct {
    last_played: [sounds.by_category.len]?u32 = [_]?u32{null} ** sounds.by_category.len,
    timestamps: [MAX_PROMPT_TRACK]i64 = [_]i64{0} ** MAX_PROMPT_TRACK,
    timestamp_count: usize = 0,
    timestamp_head: usize = 0,
    last_agent_start: i64 = 0,
    last_stop_time: i64 = 0,
    afplay_pid: ?posix.pid_t = null,
};

// ---------------------------------------------------------------------------
// Runtime

const Peon = struct {
    agent_dir: []const u8,
    config: Config = .{},
    state: State = .{},
    rng: std.Random.DefaultPrng = std.Random.DefaultPrng.init(0),

    fn onSessionStart(peon: *Peon, io: std.Io, arena: Allocator) ?sounds.Category {
        // Plays on every session start, reload included (matches the original).
        return peon.maybePlay(io, arena, .session_start);
    }

    fn onAgentStart(peon: *Peon, io: std.Io, arena: Allocator, now: i64) ?sounds.Category {
        peon.state.last_agent_start = now;
        peon.pushTimestamp(now);
        const window_ms = peon.config.annoyed_window_seconds * 1000;
        const threshold: usize = @intCast(@max(peon.config.annoyed_threshold, 1));
        if (peon.countRecent(now, window_ms) >= threshold) {
            return peon.maybePlay(io, arena, .user_spam);
        }
        return peon.maybePlay(io, arena, .task_acknowledge);
    }

    fn onToolError(peon: *Peon, io: std.Io, arena: Allocator) ?sounds.Category {
        return peon.maybePlay(io, arena, .task_error);
    }

    fn onAgentEnd(peon: *Peon, io: std.Io, arena: Allocator, now: i64, error_run: bool) ?sounds.Category {
        if (error_run) return null; // a failed run never gets the cheerful complete sound
        if (now - peon.state.last_stop_time < DEBOUNCE_MS) return null;
        peon.state.last_stop_time = now;
        const silent_ms = peon.config.silent_window_seconds * 1000;
        if (silent_ms > 0) {
            const run_ms = now - peon.state.last_agent_start;
            if (run_ms >= 0 and run_ms < silent_ms) return null;
        }
        return peon.maybePlay(io, arena, .task_complete);
    }

    fn maybePlay(peon: *Peon, io: std.Io, arena: Allocator, cat: sounds.Category) ?sounds.Category {
        if (peon.config.paused) return null;
        if (!peon.config.categories.enabled(cat)) return null;
        if (peon.play(io, arena, cat)) return cat;
        return null;
    }

    fn play(peon: *Peon, io: std.Io, arena: Allocator, cat: sounds.Category) bool {
        const s = peon.pick(cat) orelse return false;
        const path = std.fmt.allocPrint(arena, "{s}/peon-sounds/{s}", .{ peon.agent_dir, s.name }) catch return false;

        // One sound at a time: the previous event's afplay is still running
        // (its pid is in state), finish it before starting this one. The pid
        // could already have exited (harmless ESRCH) or be long gone.
        if (peon.state.afplay_pid) |pid| {
            posix.kill(pid, posix.SIG.TERM) catch {};
            peon.state.afplay_pid = null;
        }

        const vol: u8 = @min(@max(peon.config.volume, 0), 100);
        var vol_buf: [16]u8 = undefined;
        const vol_str = std.fmt.bufPrint(&vol_buf, "{d}", .{@as(f64, @floatFromInt(vol)) / 100.0}) catch "0.5";
        const argv = [_][]const u8{ "afplay", "-v", vol_str, path };
        const child = std.process.spawn(io, .{
            .argv = &argv,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| {
            std.debug.print("pi-peon: afplay spawn failed ({s})\n", .{@errorName(err)});
            return false;
        };
        peon.state.afplay_pid = child.id; // fresh spawn, id is always set
        return true;
    }

    fn pick(peon: *Peon, cat: sounds.Category) ?*const sounds.Sound {
        const all = sounds.by_category[@intFromEnum(cat)];
        if (all.len == 0) return null;
        const last = peon.state.last_played[@intFromEnum(cat)];
        var idx = peon.rng.random().intRangeLessThanBiased(usize, 0, all.len);
        if (all.len > 1 and last != null) {
            var tries: usize = 0;
            while (idx == last.? and tries < 8) : (tries += 1) {
                idx = peon.rng.random().intRangeLessThanBiased(usize, 0, all.len);
            }
        }
        peon.state.last_played[@intFromEnum(cat)] = @intCast(idx);
        return all[idx];
    }

    fn pushTimestamp(peon: *Peon, now: i64) void {
        const cap = peon.state.timestamps.len;
        if (peon.state.timestamp_count < cap) {
            peon.state.timestamps[(peon.state.timestamp_head + peon.state.timestamp_count) % cap] = now;
            peon.state.timestamp_count += 1;
        } else {
            peon.state.timestamps[peon.state.timestamp_head] = now;
            peon.state.timestamp_head = (peon.state.timestamp_head + 1) % cap;
        }
    }

    fn countRecent(peon: *const Peon, now: i64, window_ms: i64) usize {
        var count: usize = 0;
        var i: usize = 0;
        while (i < peon.state.timestamp_count) : (i += 1) {
            const t = peon.state.timestamps[(peon.state.timestamp_head + i) % peon.state.timestamps.len];
            const age = now - t;
            if (age >= 0 and age <= window_ms) count += 1;
        }
        return count;
    }
};

// ---------------------------------------------------------------------------
// Config persistence

fn saveConfig(peon: *const Peon, io: std.Io, arena: Allocator) !void {
    const path = try std.fmt.allocPrint(arena, "{s}/peon.json", .{peon.agent_dir});
    const file = try std.Io.Dir.createFileAbsolute(io, path, .{});
    defer file.close(io);
    const bytes = try json.Stringify.valueAlloc(arena, peon.config, .{});
    try writeAllIo(io, file, bytes);
    try writeAllIo(io, file, "\n");
}

fn loadConfig(peon: *Peon, io: std.Io, arena: Allocator) !void {
    const path = try std.fmt.allocPrint(arena, "{s}/peon.json", .{peon.agent_dir});
    const data = std.Io.Dir.readFileAlloc(.cwd(), io, path, arena, .limited(64 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return, // defaults apply
        else => return err,
    };
    const parsed = json.parseFromSlice(Config, arena, data, .{ .ignore_unknown_fields = true }) catch |err| return err;
    peon.config = parsed.value;
}

// ---------------------------------------------------------------------------
// Cross-call state persistence

fn loadState(peon: *Peon, io: std.Io, arena: Allocator) !void {
    const path = try std.fmt.allocPrint(arena, "{s}/peon-state.json", .{peon.agent_dir});
    const data = std.Io.Dir.readFileAlloc(.cwd(), io, path, arena, .limited(64 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return, // first event: defaults apply
        else => return err,
    };
    const parsed = json.parseFromSlice(State, arena, data, .{ .ignore_unknown_fields = true }) catch |err| return err;
    peon.state = parsed.value;
}

// Atomic-ish write: temp file + rename so a crash never truncates the state.
fn saveState(peon: *const Peon, io: std.Io, arena: Allocator) !void {
    const path = try std.fmt.allocPrint(arena, "{s}/peon-state.json", .{peon.agent_dir});
    const bytes = try json.Stringify.valueAlloc(arena, peon.state, .{});
    const tmp_path = try std.fmt.allocPrint(arena, "{s}.tmp", .{path});
    {
        const file = try std.Io.Dir.createFileAbsolute(io, tmp_path, .{});
        defer file.close(io);
        try writeAllIo(io, file, bytes);
        try writeAllIo(io, file, "\n");
    }
    std.Io.Dir.renameAbsolute(tmp_path, path, io) catch {};
}

// Extracts the embedded wavs to <agent_dir>/peon-sounds/. Idempotent: files
// that already exist are skipped.
fn extractSounds(peon: *const Peon, io: std.Io, arena: Allocator) !void {
    const dir_path = try std.fmt.allocPrint(arena, "{s}/peon-sounds", .{peon.agent_dir});
    try std.Io.Dir.createDirPath(.cwd(), io, dir_path);
    for (sounds.sounds) |s| {
        const path = try std.fmt.allocPrint(arena, "{s}/{s}", .{ dir_path, s.name });
        _ = std.Io.Dir.accessAbsolute(io, path, .{}) catch {
            const file = try std.Io.Dir.createFileAbsolute(io, path, .{});
            defer file.close(io);
            try writeAllIo(io, file, s.bytes);
        };
    }
}

// ---------------------------------------------------------------------------
// Ops

const Request = struct {
    op: []const u8,
    agent_dir: ?[]const u8 = null,
    event: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    @"error": ?bool = null,
    field: ?[]const u8 = null,
    value: ?[]const u8 = null,
};

fn opSet(peon: *Peon, io: std.Io, arena: Allocator, req: *const Request) !common.Outcome {
    const field = req.field orelse return failOutcome(arena, "set: missing field", .{});
    const value = req.value orelse return failOutcome(arena, "set: missing value", .{});
    if (mem.eql(u8, field, "paused")) {
        if (mem.eql(u8, value, "paused")) {
            peon.config.paused = true;
        } else if (mem.eql(u8, value, "active")) {
            peon.config.paused = false;
        } else {
            return failOutcome(arena, "set: paused expects active|paused", .{});
        }
    } else if (mem.eql(u8, field, "volume")) {
        const v = parsePercent(value) orelse return failOutcome(arena, "set: volume expects 10%..100%", .{});
        peon.config.volume = v;
    } else if (mem.eql(u8, field, "silent_window_seconds")) {
        const v = parseSeconds(value) orelse return failOutcome(arena, "set: silent_window_seconds expects 0s..3600s", .{});
        peon.config.silent_window_seconds = v;
    } else if (mem.startsWith(u8, field, "cat:")) {
        const on = if (mem.eql(u8, value, "on"))
            true
        else if (mem.eql(u8, value, "off"))
            false
        else
            return failOutcome(arena, "set: category expects on|off", .{});
        if (!peon.config.categories.apply(field[4..], on)) {
            return failOutcome(arena, "set: unknown category", .{});
        }
    } else {
        return failOutcome(arena, "set: unknown field", .{});
    }
    saveConfig(peon, io, arena) catch |err| return failOutcome(arena, "{s}", .{@errorName(err)});
    return .{ .ok = true };
}

fn parsePercent(s: []const u8) ?u8 {
    const t = mem.trim(u8, s, " \t");
    if (t.len < 2 or t[t.len - 1] != '%') return null;
    const n = std.fmt.parseInt(u8, mem.trim(u8, t[0 .. t.len - 1], " \t"), 10) catch return null;
    if (n < 10 or n > 100) return null;
    return n;
}

fn parseSeconds(s: []const u8) ?i64 {
    const t = mem.trim(u8, s, " \t");
    if (t.len < 2 or (t[t.len - 1] != 's' and t[t.len - 1] != 'S')) return null;
    const n = std.fmt.parseInt(i64, mem.trim(u8, t[0 .. t.len - 1], " \t"), 10) catch return null;
    if (n < 0 or n > 3600) return null;
    return n;
}

fn opEvent(peon: *Peon, io: std.Io, arena: Allocator, req: *const Request) !common.Outcome {
    const event = req.event orelse return failOutcome(arena, "event: missing event", .{});
    // State problems never break a notification: a missing or unreadable
    // state file just means the counters reset to defaults for this event.
    loadState(peon, io, arena) catch |err| {
        std.debug.print("pi-peon: state load failed ({s}), using defaults\n", .{@errorName(err)});
    };
    const now = nowRealtimeMs();
    if (mem.eql(u8, event, "session_start")) {
        _ = peon.onSessionStart(io, arena);
    } else if (mem.eql(u8, event, "agent_start")) {
        _ = peon.onAgentStart(io, arena, now);
    } else if (mem.eql(u8, event, "tool_error")) {
        _ = peon.onToolError(io, arena);
    } else if (mem.eql(u8, event, "agent_end")) {
        _ = peon.onAgentEnd(io, arena, now, req.@"error" orelse false);
    } else {
        return failOutcome(arena, "event: unknown event", .{});
    }
    saveState(peon, io, arena) catch |err| {
        std.debug.print("pi-peon: state save failed ({s})\n", .{@errorName(err)});
    };
    return .{ .ok = true };
}

// ---------------------------------------------------------------------------
// Randomness (sound picking). No global RNG in Zig 0.16, so we seed a
// per-process PRNG from wall time and an ASLR-mixed stack address. Each
// event is a fresh process, so the seed genuinely differs every call. Good
// enough for picking sounds.

fn seedFromEntropy() u64 {
    var seed: u64 = @bitCast(nowRealtimeMs());
    seed ^= @as(u64, @intCast(@intFromPtr(&seed)));
    return seed;
}

// ---------------------------------------------------------------------------
// main

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-peon '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    // The glue resolves the agent dir (pi's own path resolution) and sends it
    // here; config, state, and the extracted sounds all live under it.
    const agent_dir = req.value.agent_dir orelse respondExit(arena, io, false, "missing agent_dir");

    var peon = Peon{
        .agent_dir = agent_dir,
        .rng = std.Random.DefaultPrng.init(seedFromEntropy()),
    };
    extractSounds(&peon, io, arena) catch |err| {
        std.debug.print("pi-peon: sound extraction failed ({s})\n", .{@errorName(err)});
    };
    loadConfig(&peon, io, arena) catch |err| {
        std.debug.print("pi-peon: config load failed ({s})\n", .{@errorName(err)});
    };

    const outcome = if (mem.eql(u8, req.value.op, "config"))
        common.Outcome{ .ok = true, .text = try json.Stringify.valueAlloc(arena, peon.config, .{}) }
    else if (mem.eql(u8, req.value.op, "set"))
        opSet(&peon, io, arena, &req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else if (mem.eql(u8, req.value.op, "event"))
        opEvent(&peon, io, arena, &req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else
        respondExit(arena, io, false, "unknown op");

    respondOutcomeExit(arena, io, outcome);
}
