// pi-peon: Warcraft peon/peasant sound notifications for pi.
//
// The pi extension (extensions/peon.ts) sends one JSON request per line on
// stdin, we answer with one JSON response line on stdout. The extension owns
// the pi event wiring and the /peon settings panel; this backend owns every
// decision: when a sound plays, which sound, at what volume, and how to play
// it. The peon and peasant sound packs are embedded in the binary (see
// src/peon/sounds.zig), extracted to ~/.pi/agent/peon-sounds/ on startup,
// and played with afplay. Config lives in ~/.pi/agent/peon.json; a one-time
// migration carries values over from the old pi-peon-ping config at
// ~/.config/peon-ping/.
//
// Request line:  {"id":1,"op":"config"}
//                {"id":2,"op":"set","field":"volume","value":"75%"}
//                {"id":3,"op":"event","event":"session_start","reason":"startup"}
//                {"id":4,"op":"event","event":"agent_start"}
//                {"id":5,"op":"event","event":"tool_error"}
//                {"id":6,"op":"event","event":"agent_end","error":true}
// Response:     {"id":1,"ok":true,"config":{...}}
//               {"id":2,"ok":true}
//               {"id":3,"ok":false,"error":"..."}
//
// Events: session_start (plays session.start on every reason, reload
// included), agent_start (task.acknowledge, or user.spam when prompts arrive
// faster than the spam threshold), tool_error (task.error), agent_end
// (task.complete, gated on the run not ending in error, a debounce, and the
// silent window).

const std = @import("std");
const mem = std.mem;
const json = std.json;
const posix = std.posix;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const sounds = @import("peon/sounds.zig");
const List = common.List;
const nowRealtimeMs = common.nowRealtimeMs;
const readLine = common.readLine;
const writeAllIo = common.writeAllIo;

const MAX_LINE = 64 * 1024;
const DEBOUNCE_MS = 5000; // min gap between two task.complete sounds
const MAX_PROMPT_TRACK = 16; // ring buffer size for spam detection

// ---------------------------------------------------------------------------
// Config

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

// Old pi-peon-ping config shape; only the fields we carry over. Unknown keys
// (default_pack, relay_mode, desktop_notifications, input.required,
// resource.limit, ...) are ignored.
const OldCategories = struct {
    @"session.start": ?bool = null,
    @"task.acknowledge": ?bool = null,
    @"task.complete": ?bool = null,
    @"task.error": ?bool = null,
    @"user.spam": ?bool = null,
};

const OldConfig = struct {
    volume: ?f64 = null,
    annoyed_threshold: ?i64 = null,
    annoyed_window_seconds: ?i64 = null,
    silent_window_seconds: ?i64 = null,
    categories: ?OldCategories = null,
};

const OldState = struct {
    paused: ?bool = null,
};

// ---------------------------------------------------------------------------
// Runtime state

const Peon = struct {
    home: []const u8, // ~/.pi/agent (or a temp dir in the self-check)
    old_config_path: []const u8,
    old_state_path: []const u8,
    config: Config = .{},
    last_played: [sounds.by_category.len]?u32 = [_]?u32{null} ** sounds.by_category.len,
    timestamps: [MAX_PROMPT_TRACK]i64 = undefined,
    timestamp_count: usize = 0,
    timestamp_head: usize = 0,
    last_agent_start: i64 = 0,
    last_stop_time: i64 = 0,
    current: ?std.process.Child = null, // afplay still running
    rng: std.Random.DefaultPrng = std.Random.DefaultPrng.init(0),
    dry: bool = false, // self-check: decide and pick but never spawn afplay

    fn onSessionStart(peon: *Peon, io: std.Io, arena: Allocator) ?sounds.Category {
        // Plays on every session start, reload included (matches the original).
        return peon.maybePlay(io, arena, .session_start);
    }

    fn onAgentStart(peon: *Peon, io: std.Io, arena: Allocator, now: i64) ?sounds.Category {
        peon.last_agent_start = now;
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
        if (now - peon.last_stop_time < DEBOUNCE_MS) return null;
        peon.last_stop_time = now;
        const silent_ms = peon.config.silent_window_seconds * 1000;
        if (silent_ms > 0) {
            const run_ms = now - peon.last_agent_start;
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
        const path = std.fmt.allocPrint(arena, "{s}/peon-sounds/{s}", .{ peon.home, s.name }) catch return false;
        if (peon.dry) return true;

        if (peon.current) |*child| {
            child.kill(io); // kill the previous sound and reap it
            peon.current = null;
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
        peon.current = child;
        return true;
    }

    fn pick(peon: *Peon, cat: sounds.Category) ?*const sounds.Sound {
        const all = sounds.by_category[@intFromEnum(cat)];
        if (all.len == 0) return null;
        const last = peon.last_played[@intFromEnum(cat)];
        var idx = peon.rng.random().intRangeLessThanBiased(usize, 0, all.len);
        if (all.len > 1 and last != null) {
            var tries: usize = 0;
            while (idx == last.? and tries < 8) : (tries += 1) {
                idx = peon.rng.random().intRangeLessThanBiased(usize, 0, all.len);
            }
        }
        peon.last_played[@intFromEnum(cat)] = @intCast(idx);
        return all[idx];
    }

    fn pushTimestamp(peon: *Peon, now: i64) void {
        const cap = peon.timestamps.len;
        if (peon.timestamp_count < cap) {
            peon.timestamps[(peon.timestamp_head + peon.timestamp_count) % cap] = now;
            peon.timestamp_count += 1;
        } else {
            peon.timestamps[peon.timestamp_head] = now;
            peon.timestamp_head = (peon.timestamp_head + 1) % cap;
        }
    }

    fn countRecent(peon: *const Peon, now: i64, window_ms: i64) usize {
        var count: usize = 0;
        var i: usize = 0;
        while (i < peon.timestamp_count) : (i += 1) {
            const t = peon.timestamps[(peon.timestamp_head + i) % peon.timestamps.len];
            const age = now - t;
            if (age >= 0 and age <= window_ms) count += 1;
        }
        return count;
    }
};

// ---------------------------------------------------------------------------
// Config persistence

fn saveConfig(peon: *const Peon, io: std.Io, arena: Allocator) !void {
    const path = try std.fmt.allocPrint(arena, "{s}/peon.json", .{peon.home});
    const file = try std.Io.Dir.createFileAbsolute(io, path, .{});
    defer file.close(io);
    const bytes = try json.Stringify.valueAlloc(arena, peon.config, .{});
    try writeAllIo(io, file, bytes);
    try writeAllIo(io, file, "\n");
}

// One-time carry-over from the old pi-peon-ping install. Only runs when
// peon.json does not exist yet; after the old install is deleted this is a
// no-op and defaults apply instead.
fn migrate(peon: *Peon, io: std.Io, arena: Allocator) !void {
    const old_data = std.Io.Dir.readFileAlloc(.cwd(), io, peon.old_config_path, arena, .limited(64 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    const old = json.parseFromSlice(OldConfig, arena, old_data, .{ .ignore_unknown_fields = true }) catch {
        std.debug.print("pi-peon: could not parse old config, using defaults\n", .{});
        return;
    };
    if (old.value.volume) |v| {
        const pct = @round(v * 100);
        peon.config.volume = @intFromFloat(@min(@max(pct, 10), 100));
    }
    if (old.value.annoyed_threshold) |v| peon.config.annoyed_threshold = v;
    if (old.value.annoyed_window_seconds) |v| peon.config.annoyed_window_seconds = v;
    if (old.value.silent_window_seconds) |v| peon.config.silent_window_seconds = v;
    if (old.value.categories) |c| {
        if (c.@"session.start") |v| peon.config.categories.@"session.start" = v;
        if (c.@"task.acknowledge") |v| peon.config.categories.@"task.acknowledge" = v;
        if (c.@"task.complete") |v| peon.config.categories.@"task.complete" = v;
        if (c.@"task.error") |v| peon.config.categories.@"task.error" = v;
        if (c.@"user.spam") |v| peon.config.categories.@"user.spam" = v;
    }
    const old_state = std.Io.Dir.readFileAlloc(.cwd(), io, peon.old_state_path, arena, .limited(64 * 1024)) catch null;
    if (old_state) |data| {
        const st = json.parseFromSlice(OldState, arena, data, .{ .ignore_unknown_fields = true }) catch null;
        if (st) |s| {
            if (s.value.paused) |v| {
                peon.config.paused = v;
            }
        }
    }
    try saveConfig(peon, io, arena);
}

fn loadOrMigrate(peon: *Peon, io: std.Io, arena: Allocator) !void {
    const path = try std.fmt.allocPrint(arena, "{s}/peon.json", .{peon.home});
    const data = std.Io.Dir.readFileAlloc(.cwd(), io, path, arena, .limited(64 * 1024)) catch |err| switch (err) {
        error.FileNotFound => {
            try migrate(peon, io, arena);
            return;
        },
        else => return err,
    };
    const parsed = json.parseFromSlice(Config, arena, data, .{ .ignore_unknown_fields = true }) catch |err| return err;
    peon.config = parsed.value;
}

// Extracts the embedded wavs to ~/.pi/agent/peon-sounds/ (or the self-check
// temp home). Idempotent: files that already exist are skipped.
fn extractSounds(peon: *const Peon, io: std.Io, arena: Allocator) !void {
    const dir_path = try std.fmt.allocPrint(arena, "{s}/peon-sounds", .{peon.home});
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
// Protocol

const Request = struct {
    id: i64,
    op: []const u8,
    event: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    @"error": ?bool = null,
    field: ?[]const u8 = null,
    value: ?[]const u8 = null,
};

const Response = struct {
    id: i64,
    ok: bool,
    config: ?Config = null,
    @"error": ?[]const u8 = null,
};

fn respondJson(arena: Allocator, io: std.Io, resp: *const Response) !void {
    var buf = List.init(arena);
    const bytes = try json.Stringify.valueAlloc(arena, resp.*, .{});
    try buf.appendSlice(bytes);
    try buf.append('\n');
    try writeAllIo(io, std.Io.File.stdout(), buf.items);
}

fn fail(resp: *Response, msg: []const u8) void {
    resp.ok = false;
    resp.@"error" = msg;
}

fn opSet(peon: *Peon, io: std.Io, arena: Allocator, req: *const Request, resp: *Response) void {
    const field = req.field orelse return fail(resp, "set: missing field");
    const value = req.value orelse return fail(resp, "set: missing value");
    if (mem.eql(u8, field, "paused")) {
        if (mem.eql(u8, value, "paused")) {
            peon.config.paused = true;
        } else if (mem.eql(u8, value, "active")) {
            peon.config.paused = false;
        } else {
            return fail(resp, "set: paused expects active|paused");
        }
    } else if (mem.eql(u8, field, "volume")) {
        const v = parsePercent(value) orelse return fail(resp, "set: volume expects 10%..100%");
        peon.config.volume = v;
    } else if (mem.eql(u8, field, "silent_window_seconds")) {
        const v = parseSeconds(value) orelse return fail(resp, "set: silent_window_seconds expects 0s..3600s");
        peon.config.silent_window_seconds = v;
    } else if (mem.startsWith(u8, field, "cat:")) {
        const on = if (mem.eql(u8, value, "on"))
            true
        else if (mem.eql(u8, value, "off"))
            false
        else
            return fail(resp, "set: category expects on|off");
        if (!peon.config.categories.apply(field[4..], on)) {
            return fail(resp, "set: unknown category");
        }
    } else {
        return fail(resp, "set: unknown field");
    }
    saveConfig(peon, io, arena) catch |err| return fail(resp, @errorName(err));
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

fn opEvent(peon: *Peon, io: std.Io, arena: Allocator, req: *const Request, resp: *Response) void {
    const event = req.event orelse return fail(resp, "event: missing event");
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
        return fail(resp, "event: unknown event");
    }
}

// ---------------------------------------------------------------------------
// Randomness (sound picking, self-check temp dirs). No global RNG in
// Zig 0.16, so we seed a per-process PRNG from wall time and an ASLR-mixed
// stack address. Good enough for picking sounds.

fn seedFromEntropy() u64 {
    var seed: u64 = @bitCast(nowRealtimeMs());
    seed ^= @as(u64, @intCast(@intFromPtr(&seed)));
    return seed;
}

// ---------------------------------------------------------------------------
// self-check

fn writeText(io: std.Io, path: []const u8, text: []const u8) !void {
    const file = try std.Io.Dir.createFileAbsolute(io, path, .{});
    defer file.close(io);
    try writeAllIo(io, file, text);
}

fn selfCheck(gpa: Allocator, io: std.Io) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const expect = common.expect;

    const tmp = try std.fmt.allocPrint(arena, "/tmp/pi-peon-selfcheck-{x}", .{seedFromEntropy()});
    try std.Io.Dir.createDirPath(.cwd(), io, tmp);
    try std.Io.Dir.createDirPath(.cwd(), io, try std.fmt.allocPrint(arena, "{s}/old", .{tmp}));

    // Fresh install: defaults.
    var peon = Peon{
        .home = tmp,
        .old_config_path = try std.fmt.allocPrint(arena, "{s}/old/config.json", .{tmp}),
        .old_state_path = try std.fmt.allocPrint(arena, "{s}/old/state.json", .{tmp}),
        .dry = true,
    };
    try loadOrMigrate(&peon, io, arena);
    expect(peon.config.volume == 50, "default volume is 50");
    expect(peon.config.categories.@"task.complete", "default task.complete on");
    expect(!peon.config.paused, "default unpaused");
    expect(sounds.by_category.len == 5, "one sound list per category");

    // Migration from a fake old pi-peon-ping install.
    try writeText(io, peon.old_config_path, "{\"volume\":0.4,\"categories\":{\"task.complete\":true,\"task.error\":false,\"session.start\":false},\"annoyed_threshold\":2,\"annoyed_window_seconds\":7,\"silent_window_seconds\":3,\"default_pack\":\"peon\",\"relay_mode\":\"auto\"}");
    try writeText(io, peon.old_state_path, "{\"paused\":true,\"last_played\":{}}");
    var migrated = Peon{
        .home = tmp,
        .old_config_path = peon.old_config_path,
        .old_state_path = peon.old_state_path,
        .dry = true,
    };
    try loadOrMigrate(&migrated, io, arena);
    expect(migrated.config.volume == 40, "migration converts 0.4 to 40%");
    expect(migrated.config.paused, "migration carries paused");
    expect(migrated.config.categories.@"task.complete", "migration carries task.complete on");
    expect(!migrated.config.categories.@"task.error", "migration carries task.error off");
    expect(!migrated.config.categories.@"session.start", "migration carries session.start off");
    expect(migrated.config.categories.@"task.acknowledge", "unset category keeps its default");
    expect(migrated.config.silent_window_seconds == 3, "migration carries silent window");
    expect(migrated.config.annoyed_threshold == 2, "migration carries spam threshold");
    expect(migrated.config.annoyed_window_seconds == 7, "migration carries spam window");
    // The migrated config is persisted: a fresh load sees it, not the old file.
    var reloaded = Peon{
        .home = tmp,
        .old_config_path = peon.old_config_path,
        .old_state_path = peon.old_state_path,
        .dry = true,
    };
    try loadOrMigrate(&reloaded, io, arena);
    expect(reloaded.config.volume == 40 and reloaded.config.paused, "migrated config persisted");

    // Extraction writes the embedded wavs to the cache dir.
    try extractSounds(&reloaded, io, arena);
    const first_path = try std.fmt.allocPrint(arena, "{s}/peon-sounds/{s}", .{ tmp, sounds.sounds[0].name });
    _ = std.Io.Dir.accessAbsolute(io, first_path, .{}) catch expect(false, "sound extracted to cache");

    // Events. reloaded.config starts paused (carried from the fake state);
    // resume for the event tests.
    reloaded.config.paused = false;
    reloaded.config.categories.@"session.start" = true;
    expect(reloaded.onSessionStart(io, arena) == .session_start, "session_start plays when enabled");
    reloaded.config.categories.@"session.start" = false;
    expect(reloaded.onSessionStart(io, arena) == null, "session_start respects its toggle");
    reloaded.config.categories.@"session.start" = true;

    const t0: i64 = 1_000_000;
    reloaded.config.annoyed_threshold = 3;
    reloaded.config.annoyed_window_seconds = 10;
    expect(reloaded.onAgentStart(io, arena, t0) == .task_acknowledge, "first prompt acknowledges");
    expect(reloaded.onAgentStart(io, arena, t0 + 1000) == .task_acknowledge, "second prompt acknowledges");
    expect(reloaded.onAgentStart(io, arena, t0 + 2000) == .user_spam, "third prompt inside the window is spam");
    reloaded.config.categories.@"user.spam" = false;
    expect(reloaded.onAgentStart(io, arena, t0 + 3000) == null, "spam toggle off silences spam prompts");
    reloaded.config.categories.@"user.spam" = true;

    reloaded.config.categories.@"task.complete" = true;
    expect(reloaded.onAgentEnd(io, arena, t0 + 50_000, true) == null, "errored run plays nothing");
    reloaded.config.silent_window_seconds = 2;
    _ = reloaded.onAgentStart(io, arena, t0 + 100_000);
    expect(reloaded.onAgentEnd(io, arena, t0 + 100_500, false) == null, "run shorter than the silent window is silent");
    expect(reloaded.onAgentEnd(io, arena, t0 + 106_000, false) == .task_complete, "run past the silent window completes");
    expect(reloaded.onAgentEnd(io, arena, t0 + 106_500, false) == null, "second agent_end inside the debounce is silent");
    reloaded.config.silent_window_seconds = 0;

    reloaded.config.categories.@"task.error" = true;
    expect(reloaded.onToolError(io, arena) == .task_error, "tool error plays when enabled");
    reloaded.config.categories.@"task.error" = false;
    expect(reloaded.onToolError(io, arena) == null, "tool error respects its toggle");

    reloaded.config.paused = true;
    expect(reloaded.onToolError(io, arena) == null and reloaded.onSessionStart(io, arena) == null, "paused silences everything");
    reloaded.config.paused = false;

    // Set ops.
    var resp = Response{ .id = 1, .ok = true };
    opSet(&reloaded, io, arena, &Request{ .id = 1, .op = "set", .field = "volume", .value = "75%" }, &resp);
    expect(resp.ok and reloaded.config.volume == 75, "set volume 75%");
    resp = Response{ .id = 1, .ok = true };
    opSet(&reloaded, io, arena, &Request{ .id = 1, .op = "set", .field = "volume", .value = "5%" }, &resp);
    expect(!resp.ok, "volume below 10% rejected");
    resp = Response{ .id = 1, .ok = true };
    opSet(&reloaded, io, arena, &Request{ .id = 1, .op = "set", .field = "cat:task.error", .value = "on" }, &resp);
    expect(resp.ok and reloaded.config.categories.@"task.error", "set category on");
    resp = Response{ .id = 1, .ok = true };
    opSet(&reloaded, io, arena, &Request{ .id = 1, .op = "set", .field = "cat:input.required", .value = "on" }, &resp);
    expect(!resp.ok, "unknown category rejected");
    resp = Response{ .id = 1, .ok = true };
    opSet(&reloaded, io, arena, &Request{ .id = 1, .op = "set", .field = "silent_window_seconds", .value = "5s" }, &resp);
    expect(resp.ok and reloaded.config.silent_window_seconds == 5, "set silent window");
    resp = Response{ .id = 1, .ok = true };
    opSet(&reloaded, io, arena, &Request{ .id = 1, .op = "set", .field = "paused", .value = "active" }, &resp);
    expect(resp.ok and !reloaded.config.paused, "set sounds active");

    var persisted = Peon{
        .home = tmp,
        .old_config_path = peon.old_config_path,
        .old_state_path = peon.old_state_path,
        .dry = true,
    };
    try loadOrMigrate(&persisted, io, arena);
    expect(persisted.config.volume == 75, "set volume persisted");

    const t = reloaded.pick(.task_complete);
    expect(t != null, "pick returns a sound");
    expect(reloaded.last_played[@intFromEnum(sounds.Category.task_complete)] != null, "pick records last played");

    try std.Io.Dir.deleteTree(.cwd(), io, tmp);

    std.debug.print("PASS: pi-peon self-check ok\n", .{});
}

// ---------------------------------------------------------------------------
// main

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len > 1 and mem.eql(u8, std.mem.sliceTo(argv[1], 0), "--self-check")) {
        try selfCheck(gpa, io);
        return;
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var stdin_buf = List.init(gpa);
    defer stdin_buf.deinit();

    const home_raw = init.environ_map.get("HOME") orelse {
        std.debug.print("pi-peon: HOME not set\n", .{});
        return;
    };
    const home = std.fmt.allocPrint(init.arena.allocator(), "{s}/.pi/agent", .{home_raw}) catch return;
    var peon = Peon{
        .home = home,
        .old_config_path = std.fmt.allocPrint(init.arena.allocator(), "{s}/.config/peon-ping/config.json", .{home_raw}) catch return,
        .old_state_path = std.fmt.allocPrint(init.arena.allocator(), "{s}/.config/peon-ping/state.json", .{home_raw}) catch return,
    };
    peon.rng = std.Random.DefaultPrng.init(seedFromEntropy());
    extractSounds(&peon, io, arena_state.allocator()) catch |err| {
        std.debug.print("pi-peon: sound extraction failed ({s})\n", .{@errorName(err)});
    };
    loadOrMigrate(&peon, io, arena_state.allocator()) catch |err| {
        std.debug.print("pi-peon: config load failed ({s})\n", .{@errorName(err)});
    };

    while (true) {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();

        const line = readLine(posix.STDIN_FILENO, &stdin_buf, MAX_LINE, arena, null) catch break orelse break;
        if (line.len == 0) continue;

        const parsed = json.parseFromSlice(Request, arena, line, .{ .ignore_unknown_fields = true }) catch |err| {
            var err_resp = Response{ .id = 0, .ok = false };
            err_resp.@"error" = @errorName(err);
            respondJson(arena, io, &err_resp) catch {};
            continue;
        };
        const req = parsed.value;
        var resp = Response{ .id = req.id, .ok = true };

        if (mem.eql(u8, req.op, "config")) {
            resp.config = peon.config;
        } else if (mem.eql(u8, req.op, "set")) {
            opSet(&peon, io, arena, &req, &resp);
        } else if (mem.eql(u8, req.op, "event")) {
            opEvent(&peon, io, arena, &req, &resp);
        } else {
            fail(&resp, "unknown op");
        }

        respondJson(arena, io, &resp) catch {};
    }
}
