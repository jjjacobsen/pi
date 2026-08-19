// pi-usage: Zig backend for the /usage command.
//
// Data collection, aggregation, insights, and provider-limit fetching for the
// usage dashboard. Adapted from @tmustier/pi-usage-extension (MIT,
// https://github.com/tmustier/pi-extensions): same session-JSONL accounting
// rules and insight text, rewritten in Zig with a binary on-disk cache. The
// provider-limit fetchers are adapted from omp (can1357/oh-my-pi):
// OpenCode Go `zen/go/v1/usage` and OpenAI Codex `wham/usage`.
//
// One-shot: the request travels as one JSON argv element (the glue spawns the
// binary per call via pi.exec), the backend prints one JSON envelope to stdout
// and exits.
//   -> {"op":"collect","bounds":{"todayMs":..,"weekStartMs":..,
//       "lastWeekStartMs":..,"last30DaysStartMs":..,"nowMs":..},"agent_dir":"..."}
//   -> {"op":"limits","codex_access":"...","codex_account_id":"...",
//       "codex_email":"..."}
//   <- {"ok":true,"result":"<json>"} | {"ok":false,"error":"..."}
//
// The collect op is local-only: it scans <agent_dir>/sessions for .jsonl
// files, re-parses only files whose (size, mtime) changed since the binary
// cache (<agent_dir>/pi-usage-cache.bin), aggregates the five period views
// plus hourly buckets, and computes insights. The agent dir rides the request
// from the glue (pi's own resolution), never the environment. The limits op
// fetches provider quota over HTTPS on the main thread; a hung network is
// bounded by the glue's pi.exec timeout. The Codex credentials (access token,
// account id, email) are resolved by the glue through pi's model registry —
// refresh and auth.json rewriting stay in pi — and passed per request; this
// backend never touches the credential file.
//
// Unix-only by design; pi itself is Unix-first.

const std = @import("std");
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;

fn ManagedList(comptime T: type) type {
    return std.array_list.AlignedManaged(T, null);
}
const nowRealtimeMs = common.nowRealtimeMs;
const writeAllIo = common.writeAllIo;
const respondExit = common.respondExit;
const appendJsonEscaped = common.appendJsonEscaped;

const CACHE_MAGIC: u32 = 0x4355_4950; // "PIUC"
const CACHE_VERSION: u32 = 1;

const HOUR_MS: f64 = 3_600_000;
const DAY_MS: f64 = 24 * HOUR_MS;

// Insight thresholds, copied from the original extension (data.ts).
const CTX_TAX_THRESHOLD: f64 = 150_000;
const CTX_LOW_THRESHOLD: f64 = 100_000;
const PROJECT_TOP_COUNT: usize = 3;
const PROJECT_MAX_DOMINANCE_PERCENT: f64 = 90;
const REASONING_MIN_PERCENT: f64 = 5;
const TREND_HIGH_RATIO: f64 = 1.5;
const TREND_LOW_RATIO: f64 = 0.6;
const TTL_GAP_MS: f64 = 5 * 60_000;
const MISS_MIN_PREV_CONTEXT: f64 = 20_000;
const MISS_MAX_CACHE_READ: f64 = 5_000;
const CACHE_MISS_ALARM_PERCENT: f64 = 2;
const CACHE_MISS_ALARM_MIN_COST: f64 = 1;
const TOP_SESSION_COUNT: usize = 5;
const CONCENTRATION_ALARM_PERCENT: f64 = 35;
const UPFRONT_ALARM_PERCENT: f64 = 8;
const LEVERAGE_FLOOR: f64 = 5;
const LEVERAGE_MIN_COST: f64 = 5;
const LEVERAGE_MIN_FRESH_TOKENS: f64 = 1_000_000;

const AUXILIARY_PROVIDER = "Tools";
const AUXILIARY_MODEL = "summaries";
const AUXILIARY_THINKING_LEVEL = "Tools/summaries";

// =============================================================================
// Value helpers
// =============================================================================

fn asNum(v: ?json.Value) f64 {
    const x = v orelse return 0;
    return switch (x) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => 0,
    };
}

fn asStr(v: ?json.Value) ?[]const u8 {
    const x = v orelse return null;
    return switch (x) {
        .string => |s| s,
        else => null,
    };
}

fn asBool(v: ?json.Value) ?bool {
    const x = v orelse return null;
    return switch (x) {
        .bool => |b| b,
        else => null,
    };
}

fn strEq(v: ?json.Value, comptime s: []const u8) bool {
    const x = v orelse return false;
    return switch (x) {
        .string => |str| mem.eql(u8, str, s),
        else => false,
    };
}
// =============================================================================
// ISO-8601 timestamps ("2026-08-14T00:44:30.692Z" or with a ±HH:MM offset)
// =============================================================================

fn daysFromCivil(y_in: i64, m_in: i64, d_in: i64) i64 {
    const y = if (m_in <= 2) y_in - 1 else y_in;
    const era = @divFloor(y, 400);
    const yoe = y - era * 400; // [0, 399]
    const mp = @mod(m_in + 9, 12); // [0, 11]
    const doy = @divFloor(153 * mp + 2, 5) + d_in - 1; // [0, 365]
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

/// Parse an ISO-8601 timestamp into epoch milliseconds; 0 on any malformed input.
fn parseIsoMs(s: []const u8) f64 {
    if (s.len < 19) return 0;
    if (s[4] != '-' or s[7] != '-') return 0;
    if (s[10] != 'T' and s[10] != ' ') return 0;
    if (s[13] != ':' or s[16] != ':') return 0;
    const y = std.fmt.parseInt(i64, s[0..4], 10) catch return 0;
    const mo = std.fmt.parseInt(i64, s[5..7], 10) catch return 0;
    const d = std.fmt.parseInt(i64, s[8..10], 10) catch return 0;
    const h = std.fmt.parseInt(i64, s[11..13], 10) catch return 0;
    const mi = std.fmt.parseInt(i64, s[14..16], 10) catch return 0;
    const se = std.fmt.parseInt(i64, s[17..19], 10) catch return 0;
    if (mo < 1 or mo > 12 or d < 1 or d > 31 or h > 23 or mi > 59 or se > 60) return 0;
    var ms: f64 = 0;
    var rest = s[19..];
    if (rest.len > 0 and rest[0] == '.') {
        const dot_end = std.mem.indexOfAny(u8, rest, "Zz+-") orelse rest.len;
        const frac = rest[1..@min(dot_end, 4)]; // up to 3 digits
        var padded: [3]u8 = .{ '0', '0', '0' };
        @memcpy(padded[0..frac.len], frac);
        ms = @floatFromInt(std.fmt.parseInt(u64, &padded, 10) catch 0);
        rest = rest[dot_end..];
    }
    var offset_ms: f64 = 0;
    if (rest.len > 0 and (rest[0] == 'Z' or rest[0] == 'z')) {
        // UTC
    } else if (rest.len >= 6 and (rest[0] == '+' or rest[0] == '-')) {
        const oh = std.fmt.parseInt(i64, rest[1..3], 10) catch return 0;
        const om = std.fmt.parseInt(i64, rest[4..6], 10) catch return 0;
        const total = (oh * 60 + om) * 60_000;
        offset_ms = if (rest[0] == '-') @as(f64, @floatFromInt(total)) else -@as(f64, @floatFromInt(total));
    } else if (rest.len > 0) {
        return 0;
    }
    const days = daysFromCivil(y, mo, d);
    const base: f64 = @floatFromInt(days * 86_400_000);
    return base + @as(f64, @floatFromInt((h * 3600 + mi * 60 + se) * 1000)) + ms + offset_ms;
}

// =============================================================================
// Session file parsing
// =============================================================================

const UsageAmount = struct {
    cost: f64 = 0,
    input: f64 = 0,
    output: f64 = 0,
    cache_read: f64 = 0,
    cache_write: f64 = 0,
    reasoning: f64 = 0,
};

const Message = struct {
    provider: []const u8,
    model: []const u8,
    level: []const u8, // thinking level active when produced
    source_id: []const u8 = "", // entry id for auxiliary records
    cost: f64 = 0,
    input: f64 = 0,
    output: f64 = 0,
    cache_read: f64 = 0,
    cache_write: f64 = 0,
    timestamp: f64 = 0,
    reasoning: f64 = 0,
    after_compaction: bool = false,
    auxiliary: bool = false,
};

const ParsedFile = struct {
    session_id: []const u8 = "",
    cwd: []const u8 = "",
    messages: []Message = &.{},
};

fn parseUsage(v: ?json.Value) ?UsageAmount {
    const usage = v orelse return null;
    if (usage != .object) return null;
    const obj = usage.object;
    const cost_value = obj.get("cost") orelse return null;
    const cost: f64 = switch (cost_value) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .object => |co| asNum(co.get("total")),
        else => 0,
    };
    const result = UsageAmount{
        .cost = cost,
        .input = asNum(obj.get("input")),
        .output = asNum(obj.get("output")),
        .cache_read = asNum(obj.get("cacheRead")),
        .cache_write = asNum(obj.get("cacheWrite")),
        .reasoning = asNum(obj.get("reasoning")),
    };
    if (result.cost == 0 and result.input == 0 and result.output == 0 and result.cache_read == 0 and result.cache_write == 0) return null;
    return result;
}

const PAT_ASSISTANT_C = "\"role\":\"assistant\"";
const PAT_ASSISTANT_S = "\"role\": \"assistant\"";
const PAT_TOOLRESULT_C = "\"role\":\"toolResult\"";
const PAT_TOOLRESULT_S = "\"role\": \"toolResult\"";
const PAT_SESSION_C = "\"type\":\"session\"";
const PAT_SESSION_S = "\"type\": \"session\"";
const PAT_THINKING_C = "\"type\":\"thinking_level_change\"";
const PAT_THINKING_S = "\"type\": \"thinking_level_change\"";
const PAT_COMPACTION_C = "\"type\":\"compaction\"";
const PAT_COMPACTION_S = "\"type\": \"compaction\"";
const PAT_BRANCH_C = "\"type\":\"branch_summary\"";
const PAT_BRANCH_S = "\"type\": \"branch_summary\"";

/// Cheap pre-filter: only lines that could carry accounting are JSON-parsed.
/// Tool results are skipped unless they carry usage: delegated model calls
/// (describe_image, web_search) report their token accounting on the tool
/// result, and that usage appears nowhere else, so it must be aggregated;
/// plain tool output (multi-megabyte reads, browser dumps) has no usage and
/// is skipped without ever being decoded. The usage key is serialized after
/// the content, so a whole-line check is required, not just the head.
fn lineMightBeRelevant(line: []const u8) bool {
    const head = line[0..@min(line.len, 1024)];
    if (mem.indexOf(u8, head, PAT_ASSISTANT_C) != null or
        mem.indexOf(u8, head, PAT_ASSISTANT_S) != null or
        mem.indexOf(u8, head, PAT_SESSION_C) != null or
        mem.indexOf(u8, head, PAT_SESSION_S) != null or
        mem.indexOf(u8, head, PAT_THINKING_C) != null or
        mem.indexOf(u8, head, PAT_THINKING_S) != null or
        mem.indexOf(u8, head, PAT_COMPACTION_C) != null or
        mem.indexOf(u8, head, PAT_COMPACTION_S) != null or
        mem.indexOf(u8, head, PAT_BRANCH_C) != null or
        mem.indexOf(u8, head, PAT_BRANCH_S) != null) return true;
    if (mem.indexOf(u8, head, PAT_TOOLRESULT_C) != null or mem.indexOf(u8, head, PAT_TOOLRESULT_S) != null) {
        return mem.lastIndexOf(u8, line, "\"usage\":") != null;
    }
    return false;
}

fn parseSessionBuffer(arena: Allocator, buffer: []const u8) !ParsedFile {
    var result = ParsedFile{};
    var messages: ManagedList(Message) = ManagedList(Message).init(arena);
    var thinking_level: []const u8 = "";
    var compaction_pending = false;

    var it = std.mem.splitScalar(u8, buffer, '\n');
    while (it.next()) |line| {
        if (line.len == 0 or !lineMightBeRelevant(line)) continue;
        const parsed = json.parseFromSlice(json.Value, arena, line, .{ .allocate = .alloc_always }) catch continue;
        const entry = parsed.value;
        if (entry != .object) continue;
        const e = entry.object;

        if (strEq(e.get("type"), "session")) {
            result.session_id = asStr(e.get("id")) orelse "";
            result.cwd = asStr(e.get("cwd")) orelse "";
        } else if (strEq(e.get("type"), "thinking_level_change")) {
            thinking_level = asStr(e.get("thinkingLevel")) orelse "";
        } else if (strEq(e.get("type"), "compaction") or strEq(e.get("type"), "branch_summary")) {
            if (parseUsage(e.get("usage"))) |usage| {
                try messages.append(.{
                    .provider = AUXILIARY_PROVIDER,
                    .model = AUXILIARY_MODEL,
                    .level = AUXILIARY_THINKING_LEVEL,
                    .source_id = asStr(e.get("id")) orelse "",
                    .cost = usage.cost,
                    .input = usage.input,
                    .output = usage.output,
                    .cache_read = usage.cache_read,
                    .cache_write = usage.cache_write,
                    .timestamp = parseIsoMs(asStr(e.get("timestamp")) orelse ""),
                    .reasoning = usage.reasoning,
                    .auxiliary = true,
                });
            }
            if (strEq(e.get("type"), "compaction")) compaction_pending = true;
        } else if (strEq(e.get("type"), "message")) {
            const msg = e.get("message") orelse continue;
            if (msg != .object) continue;
            const m = msg.object;
            if (strEq(m.get("role"), "assistant")) {
                const provider = asStr(m.get("provider")) orelse continue;
                const model = asStr(m.get("model")) orelse continue;
                const usage = parseUsage(m.get("usage")) orelse continue;
                var timestamp = asNum(m.get("timestamp"));
                if (timestamp == 0) timestamp = parseIsoMs(asStr(e.get("timestamp")) orelse "");
                try messages.append(.{
                    .provider = provider,
                    .model = model,
                    .level = thinking_level,
                    .cost = usage.cost,
                    .input = usage.input,
                    .output = usage.output,
                    .cache_read = usage.cache_read,
                    .cache_write = usage.cache_write,
                    .timestamp = timestamp,
                    .reasoning = usage.reasoning,
                    .after_compaction = compaction_pending,
                });
                compaction_pending = false;
            } else if (strEq(m.get("role"), "toolResult")) {
                // Delegated model calls report their usage on the tool result
                // (describe_image, web_search); it appears nowhere else, so it
                // is aggregated as auxiliary provider cost under the tool name.
                const usage = parseUsage(m.get("usage")) orelse continue;
                const tool_name = asStr(m.get("toolName")) orelse "tool";
                var timestamp = asNum(m.get("timestamp"));
                if (timestamp == 0) timestamp = parseIsoMs(asStr(e.get("timestamp")) orelse "");
                try messages.append(.{
                    .provider = AUXILIARY_PROVIDER,
                    .model = tool_name,
                    .level = AUXILIARY_THINKING_LEVEL,
                    .source_id = asStr(e.get("id")) orelse "",
                    .cost = usage.cost,
                    .input = usage.input,
                    .output = usage.output,
                    .cache_read = usage.cache_read,
                    .cache_write = usage.cache_write,
                    .timestamp = timestamp,
                    .reasoning = usage.reasoning,
                    .after_compaction = compaction_pending,
                    .auxiliary = true,
                });
            }
        }
    }
    result.messages = try messages.toOwnedSlice();
    return result;
}

// =============================================================================
// Binary on-disk cache (little-endian)
//
// u32 magic "PIUC", u32 version, u32 string_count, strings (u32 len + bytes),
// u32 file_count, then per file:
//   u32 path_idx, u64 size, i64 mtime_ms, u32 session_idx, u32 cwd_idx,
//   u32 message_count, then fixed 74-byte records:
//   u32 provider_idx, u32 model_idx, u32 level_idx, u32 source_id_idx,
//   f64 cost, f64 input, f64 output, f64 cache_read, f64 cache_write,
//   f64 timestamp, f64 reasoning, u8 after_compaction, u8 auxiliary
// =============================================================================

const CachedFile = struct {
    path: []const u8,
    size: u64,
    mtime_ms: i64,
    session_id: []const u8,
    cwd: []const u8,
    messages: []Message,
};

const Cache = struct {
    files: std.StringHashMap(CachedFile),
};

const MsgKey = struct {
    auxiliary: bool,
    source_id: []const u8,
    timestamp: f64,
    fingerprint: f64,
};

const MsgKeyCtx = struct {
    pub fn hash(_: MsgKeyCtx, k: MsgKey) u64 {
        var h = std.hash.Wyhash.init(0);
        h.update(std.mem.asBytes(&k.auxiliary));
        h.update(std.mem.asBytes(&k.timestamp));
        h.update(std.mem.asBytes(&k.fingerprint));
        if (k.auxiliary) h.update(k.source_id);
        return h.final();
    }
    pub fn eql(_: MsgKeyCtx, a: MsgKey, b: MsgKey) bool {
        return a.auxiliary == b.auxiliary and a.timestamp == b.timestamp and
            a.fingerprint == b.fingerprint and
            (!a.auxiliary or mem.eql(u8, a.source_id, b.source_id));
    }
};

fn readU32(data: []const u8, off: *usize) !u32 {
    if (off.* + 4 > data.len) return error.Truncated;
    const v = std.mem.readInt(u32, data[off.*..][0..4], .little);
    off.* += 4;
    return v;
}
fn readU64(data: []const u8, off: *usize) !u64 {
    if (off.* + 8 > data.len) return error.Truncated;
    const v = std.mem.readInt(u64, data[off.*..][0..8], .little);
    off.* += 8;
    return v;
}
fn readI64(data: []const u8, off: *usize) !i64 {
    if (off.* + 8 > data.len) return error.Truncated;
    const v = std.mem.readInt(i64, data[off.*..][0..8], .little);
    off.* += 8;
    return v;
}
fn readF64(data: []const u8, off: *usize) !f64 {
    return @bitCast(try readU64(data, off));
}
fn readU8(data: []const u8, off: *usize) !u8 {
    if (off.* + 1 > data.len) return error.Truncated;
    const v = data[off.*];
    off.* += 1;
    return v;
}

fn strAt(strings: []const []const u8, data: []const u8, off: *usize) ![]const u8 {
    const idx = try readU32(data, off);
    if (idx >= strings.len) return error.CorruptCache;
    return strings[idx];
}

fn writeU32(list: *List, v: u32) !void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, v, .little);
    try list.appendSlice(&buf);
}
fn writeU64(list: *List, v: u64) !void {
    var buf: [8]u8 = undefined;
    std.mem.writeInt(u64, &buf, v, .little);
    try list.appendSlice(&buf);
}
fn writeI64(list: *List, v: i64) !void {
    var buf: [8]u8 = undefined;
    std.mem.writeInt(i64, &buf, v, .little);
    try list.appendSlice(&buf);
}
fn writeF64(list: *List, v: f64) !void {
    var buf: [8]u8 = undefined;
    std.mem.writeInt(u64, &buf, @bitCast(v), .little);
    try list.appendSlice(&buf);
}
fn writeU8(list: *List, v: u8) !void {
    try list.append(v);
}

fn loadCache(io: std.Io, arena: Allocator, cache_path: []const u8) !Cache {
    var result = Cache{ .files = std.StringHashMap(CachedFile).init(arena) };
    const data = std.Io.Dir.readFileAlloc(.cwd(), io, cache_path, arena, .limited(512 * 1024 * 1024)) catch return result;
    if (data.len < 12) return result;
    var off: usize = 0;
    const magic = std.mem.readInt(u32, data[off..][0..4], .little);
    off += 4;
    const version = std.mem.readInt(u32, data[off..][0..4], .little);
    off += 4;
    if (magic != CACHE_MAGIC or version != CACHE_VERSION) return result;
    const string_count = try readU32(data, &off);
    var strings = ManagedList([]const u8).init(arena);
    try strings.ensureTotalCapacity(string_count);
    for (0..string_count) |_| {
        const len = try readU32(data, &off);
        if (off + len > data.len) return result;
        strings.appendAssumeCapacity(data[off .. off + len]);
        off += len;
    }
    const file_count = try readU32(data, &off);
    for (0..file_count) |_| {
        const path = try strAt(strings.items, data, &off);
        const size = try readU64(data, &off);
        const mtime_ms = try readI64(data, &off);
        const session_id = try strAt(strings.items, data, &off);
        const cwd = try strAt(strings.items, data, &off);
        const msg_count = try readU32(data, &off);
        var messages = ManagedList(Message).init(arena);
        try messages.ensureTotalCapacity(msg_count);
        for (0..msg_count) |_| {
            const provider = try strAt(strings.items, data, &off);
            const model = try strAt(strings.items, data, &off);
            const level = try strAt(strings.items, data, &off);
            const source_id = try strAt(strings.items, data, &off);
            const cost = try readF64(data, &off);
            const input = try readF64(data, &off);
            const output = try readF64(data, &off);
            const cache_read = try readF64(data, &off);
            const cache_write = try readF64(data, &off);
            const timestamp = try readF64(data, &off);
            const reasoning = try readF64(data, &off);
            const after_compaction = try readU8(data, &off);
            const auxiliary = try readU8(data, &off);
            messages.appendAssumeCapacity(.{
                .provider = provider,
                .model = model,
                .level = level,
                .source_id = source_id,
                .cost = cost,
                .input = input,
                .output = output,
                .cache_read = cache_read,
                .cache_write = cache_write,
                .timestamp = timestamp,
                .reasoning = reasoning,
                .after_compaction = after_compaction != 0,
                .auxiliary = auxiliary != 0,
            });
        }
        try result.files.put(path, .{
            .path = path,
            .size = size,
            .mtime_ms = mtime_ms,
            .session_id = session_id,
            .cwd = cwd,
            .messages = try messages.toOwnedSlice(),
        });
    }
    return result;
}

const Interner = struct {
    map: std.StringHashMap(u32),
    list: ManagedList([]const u8),
    arena: Allocator,

    fn init(arena: Allocator) Interner {
        return .{
            .map = std.StringHashMap(u32).init(arena),
            .list = ManagedList([]const u8).init(arena),
            .arena = arena,
        };
    }
    fn intern(self: *Interner, s: []const u8) !u32 {
        if (self.map.get(s)) |idx| return idx;
        const owned = try self.arena.dupe(u8, s);
        const idx: u32 = @intCast(self.list.items.len);
        try self.list.append(owned);
        try self.map.put(owned, idx);
        return idx;
    }
};

fn saveCache(io: std.Io, arena: Allocator, cache_path: []const u8, files: []const CachedFile) !void {
    var buf = List.init(arena);
    try writeU32(&buf, CACHE_MAGIC);
    try writeU32(&buf, CACHE_VERSION);
    var interner = Interner.init(arena);
    for (files) |f| {
        _ = try interner.intern(f.path);
        _ = try interner.intern(f.session_id);
        _ = try interner.intern(f.cwd);
        for (f.messages) |m| {
            _ = try interner.intern(m.provider);
            _ = try interner.intern(m.model);
            _ = try interner.intern(m.level);
            _ = try interner.intern(m.source_id);
        }
    }
    try writeU32(&buf, @intCast(interner.list.items.len));
    for (interner.list.items) |s| {
        try writeU32(&buf, @intCast(s.len));
        try buf.appendSlice(s);
    }
    try writeU32(&buf, @intCast(files.len));
    for (files) |f| {
        try writeU32(&buf, interner.map.get(f.path).?);
        try writeU64(&buf, f.size);
        try writeI64(&buf, f.mtime_ms);
        try writeU32(&buf, interner.map.get(f.session_id).?);
        try writeU32(&buf, interner.map.get(f.cwd).?);
        try writeU32(&buf, @intCast(f.messages.len));
        for (f.messages) |m| {
            try writeU32(&buf, interner.map.get(m.provider).?);
            try writeU32(&buf, interner.map.get(m.model).?);
            try writeU32(&buf, interner.map.get(m.level).?);
            try writeU32(&buf, interner.map.get(m.source_id).?);
            try writeF64(&buf, m.cost);
            try writeF64(&buf, m.input);
            try writeF64(&buf, m.output);
            try writeF64(&buf, m.cache_read);
            try writeF64(&buf, m.cache_write);
            try writeF64(&buf, m.timestamp);
            try writeF64(&buf, m.reasoning);
            try writeU8(&buf, if (m.after_compaction) 1 else 0);
            try writeU8(&buf, if (m.auxiliary) 1 else 0);
        }
    }

    // Atomic-ish write: temp file + rename so a crash never truncates the cache.
    const tmp_path = try std.fmt.allocPrint(arena, "{s}.tmp", .{cache_path});
    {
        const file = try std.Io.Dir.createFileAbsolute(io, tmp_path, .{});
        defer file.close(io);
        try writeAllIo(io, file, buf.items);
    }
    std.Io.Dir.renameAbsolute(tmp_path, cache_path, io) catch {};
}

// =============================================================================
// Aggregation
// =============================================================================

const Bounds = struct {
    todayMs: f64,
    weekStartMs: f64,
    lastWeekStartMs: f64,
    last30DaysStartMs: f64,
    nowMs: f64,
};

const TokenStats = struct {
    total: f64 = 0,
    input: f64 = 0,
    output: f64 = 0,
    cache_read: f64 = 0,
    cache_write: f64 = 0,
};

const ModelStats = struct {
    sessions: std.StringHashMap(void),
    messages: u64 = 0,
    cost: f64 = 0,
    tokens: TokenStats = .{},
};

const ProviderStats = struct {
    sessions: std.StringHashMap(void),
    messages: u64 = 0,
    cost: f64 = 0,
    tokens: TokenStats = .{},
    models: std.StringHashMap(ModelStats),
};

const Totals = struct {
    sessions: u64 = 0,
    messages: u64 = 0,
    cost: f64 = 0,
    tokens: TokenStats = .{},
};

const CostCount = struct { cost: f64 = 0, messages: u64 = 0 };

const PeriodRaw = struct {
    total_cost: f64 = 0,
    assistant_cost: f64 = 0,
    auxiliary_cost: f64 = 0,
    ctx_high: CostCount = .{},
    ctx_low: CostCount = .{},
    project_costs: std.StringHashMap(f64),
    session_costs: std.StringHashMap(f64),
    upfront_cost: f64 = 0,
    ttl_miss_cost: f64 = 0,
    switch_miss_cost: f64 = 0,
    prefix_miss_cost: f64 = 0,
    reasoning_tokens: f64 = 0,
    output_tokens: f64 = 0,
    cache_read_tokens: f64 = 0,
    fresh_tokens: f64 = 0,
};

const HourlyCell = struct {
    messages: u64 = 0,
    cost: f64 = 0,
    input: f64 = 0,
    output: f64 = 0,
    cache_read: f64 = 0,
    cache_write: f64 = 0,
    reasoning: f64 = 0,
};

const Period = struct {
    providers: std.StringHashMap(ProviderStats),
    totals: Totals = .{},
    raw: PeriodRaw,
    insights: []Insight = &.{},
};

const Hourly = std.AutoHashMap(i64, *std.StringHashMap(HourlyCell));

const Trend = struct { last7_cost: f64, prior_weekly_pace: f64 };

const Insight = struct {
    kind: []const u8, // "structure" | "alarm"
    stat: []const u8,
    headline: []const u8,
    advice: []const u8,
};

const Aggregated = struct {
    periods: [5]Period,
    hourly: Hourly,
    trend: ?Trend = null,
};

const PeriodIndex = enum(u8) { today = 0, this_week = 1, last_week = 2, last30 = 3, all_time = 4 };

fn emptyProvider(arena: Allocator) ProviderStats {
    return .{
        .sessions = std.StringHashMap(void).init(arena),
        .models = std.StringHashMap(ModelStats).init(arena),
    };
}

fn emptyModel(arena: Allocator) ModelStats {
    return .{ .sessions = std.StringHashMap(void).init(arena) };
}

fn emptyRaw(arena: Allocator) PeriodRaw {
    return .{
        .project_costs = std.StringHashMap(f64).init(arena),
        .session_costs = std.StringHashMap(f64).init(arena),
    };
}

fn accumulateStats(messages: *u64, cost_out: *f64, tokens: *TokenStats, add_cost: f64, tok: TokenStats, count_message: bool) void {
    if (count_message) messages.* += 1;
    cost_out.* += add_cost;
    tokens.total += tok.total;
    tokens.input += tok.input;
    tokens.output += tok.output;
    tokens.cache_read += tok.cache_read;
    tokens.cache_write += tok.cache_write;
}

fn projectLabelFromCwd(arena: Allocator, cwd: []const u8, home: []const u8) ![]const u8 {
    if (cwd.len == 0) return "(unknown)";
    var home_prefix: ?[]const u8 = null;
    if (mem.eql(u8, cwd, home) or mem.startsWith(u8, cwd, home) and cwd.len > home.len and cwd[home.len] == '/') {
        home_prefix = home;
    } else if (mem.startsWith(u8, cwd, "/Users/")) {
        const rest = cwd[7..];
        if (std.mem.indexOfScalar(u8, rest, '/')) |idx| {
            home_prefix = cwd[0 .. 7 + idx];
        }
    } else if (mem.startsWith(u8, cwd, "/home/")) {
        const rest = cwd[6..];
        if (std.mem.indexOfScalar(u8, rest, '/')) |idx| {
            home_prefix = cwd[0 .. 6 + idx];
        }
    }
    if (home_prefix) |hp| {
        if (cwd.len <= hp.len) return "~";
    }
    const rel = if (home_prefix) |hp| cwd[hp.len + 1 ..] else cwd;
    var trimmed = rel;
    if (std.mem.indexOf(u8, trimmed, "/.worktrees/")) |wt| trimmed = trimmed[0..wt];
    var parts = std.mem.splitScalar(u8, trimmed, '/');
    var kept: [2][]const u8 = undefined;
    var n: usize = 0;
    while (parts.next()) |part| {
        if (part.len == 0) continue;
        if (n >= 2) break;
        kept[n] = part;
        n += 1;
    }
    if (n == 0) return if (home_prefix != null) "~" else "/";
    const label = if (n == 1) kept[0] else try std.fmt.allocPrint(arena, "{s}/{s}", .{ kept[0], kept[1] });
    return if (home_prefix != null)
        try std.fmt.allocPrint(arena, "~/{s}", .{label})
    else
        try std.fmt.allocPrint(arena, "/{s}", .{label});
}

const Meta = struct {
    gap_ms: f64 = -1,
    prev_ctx: f64 = 0,
    model_switched: bool = false,
    is_session_start: bool = false,
};

const EXCLUDED_PROVIDERS = [_][]const u8{ "faux-provider", "fake-provider" };

fn isExcludedProvider(p: []const u8) bool {
    for (EXCLUDED_PROVIDERS) |e| {
        if (mem.eql(u8, p, e)) return true;
    }
    return false;
}

fn addMessage(
    arena: Allocator,
    agg: *Aggregated,
    session_id: []const u8,
    project: []const u8,
    msg: Message,
    meta: Meta,
    bounds: Bounds,
    cost_by_day: *std.AutoHashMap(i64, f64),
    session_contributed: *[5]bool,
) !void {
    if (isExcludedProvider(msg.provider)) return;

    // Day-indexed cost totals power the burn-trend insight.
    if (msg.timestamp > 0) {
        const day_idx: i64 = @intFromFloat(@floor((msg.timestamp - bounds.todayMs) / DAY_MS));
        const gop = try cost_by_day.getOrPut(day_idx);
        if (!gop.found_existing) gop.value_ptr.* = 0;
        gop.value_ptr.* += msg.cost;
    }

    // Hourly bucket for the graph explorer.
    if (msg.timestamp > 0) {
        const hour: i64 = @intFromFloat(@floor(msg.timestamp / HOUR_MS) * HOUR_MS);
        const gop = try agg.hourly.getOrPut(hour);
        if (!gop.found_existing) {
            const bucket = try arena.create(std.StringHashMap(HourlyCell));
            bucket.* = std.StringHashMap(HourlyCell).init(arena);
            gop.value_ptr.* = bucket;
        }
        const key = try std.fmt.allocPrint(arena, "{s}\x00{s}\x00{s}", .{ msg.provider, msg.model, msg.level });
        const cell_gop = try gop.value_ptr.*.getOrPut(key);
        if (!cell_gop.found_existing) cell_gop.value_ptr.* = .{};
        if (!msg.auxiliary) cell_gop.value_ptr.*.messages += 1;
        cell_gop.value_ptr.*.cost += msg.cost;
        cell_gop.value_ptr.*.input += msg.input;
        cell_gop.value_ptr.*.output += msg.output;
        cell_gop.value_ptr.*.cache_read += msg.cache_read;
        cell_gop.value_ptr.*.cache_write += msg.cache_write;
        cell_gop.value_ptr.*.reasoning += msg.reasoning;
    }

    const tokens = TokenStats{
        .total = msg.input + msg.output + msg.cache_write,
        .input = msg.input,
        .output = msg.output,
        .cache_read = msg.cache_read,
        .cache_write = msg.cache_write,
    };

    var periods: [5]bool = .{ false, false, false, false, false };
    periods[@intFromEnum(PeriodIndex.all_time)] = true;
    if (msg.timestamp >= bounds.todayMs) {
        periods[@intFromEnum(PeriodIndex.today)] = true;
    }
    if (msg.timestamp >= bounds.weekStartMs) {
        periods[@intFromEnum(PeriodIndex.this_week)] = true;
    } else if (msg.timestamp >= bounds.lastWeekStartMs) {
        periods[@intFromEnum(PeriodIndex.last_week)] = true;
    }
    if (msg.timestamp >= bounds.last30DaysStartMs) {
        periods[@intFromEnum(PeriodIndex.last30)] = true;
    }

    const is_assistant = !msg.auxiliary;
    for (0..5) |pi| {
        if (!periods[pi]) continue;
        const period = &agg.periods[pi];
        const gop = try period.providers.getOrPut(msg.provider);
        if (!gop.found_existing) gop.value_ptr.* = emptyProvider(arena);
        const provider = gop.value_ptr;

        const mgop = try provider.models.getOrPut(msg.model);
        if (!mgop.found_existing) mgop.value_ptr.* = emptyModel(arena);
        const model = mgop.value_ptr;

        try model.sessions.put(session_id, {});
        if (is_assistant) model.messages += 1;
        accumulateStats(&model.messages, &model.cost, &model.tokens, msg.cost, tokens, false);

        try provider.sessions.put(session_id, {});
        if (is_assistant) provider.messages += 1;
        accumulateStats(&provider.messages, &provider.cost, &provider.tokens, msg.cost, tokens, false);

        accumulateStats(&period.totals.messages, &period.totals.cost, &period.totals.tokens, msg.cost, tokens, is_assistant);
        session_contributed[pi] = true;

        const raw = &period.raw;
        raw.total_cost += msg.cost;
        const pgop = try raw.project_costs.getOrPut(project);
        if (!pgop.found_existing) pgop.value_ptr.* = 0;
        pgop.value_ptr.* += msg.cost;
        const sgop = try raw.session_costs.getOrPut(session_id);
        if (!sgop.found_existing) sgop.value_ptr.* = 0;
        sgop.value_ptr.* += msg.cost;

        if (!is_assistant) {
            raw.auxiliary_cost += msg.cost;
            continue;
        }
        raw.assistant_cost += msg.cost;

        const ctx = msg.input + msg.cache_read + msg.cache_write;
        if (ctx >= CTX_TAX_THRESHOLD) {
            raw.ctx_high.cost += msg.cost;
            raw.ctx_high.messages += 1;
        } else if (ctx < CTX_LOW_THRESHOLD) {
            raw.ctx_low.cost += msg.cost;
            raw.ctx_low.messages += 1;
        }
        if (meta.is_session_start) raw.upfront_cost += msg.cost;
        if (!msg.after_compaction and
            meta.prev_ctx >= MISS_MIN_PREV_CONTEXT and
            msg.cache_read < @min(MISS_MAX_CACHE_READ, 0.3 * meta.prev_ctx))
        {
            if (meta.gap_ms > TTL_GAP_MS) {
                raw.ttl_miss_cost += msg.cost;
            } else if (meta.gap_ms >= 0 and meta.model_switched) {
                raw.switch_miss_cost += msg.cost;
            } else if (meta.gap_ms >= 0) {
                raw.prefix_miss_cost += msg.cost;
            }
        }
        raw.reasoning_tokens += msg.reasoning;
        raw.output_tokens += msg.output;
        raw.cache_read_tokens += msg.cache_read;
        raw.fresh_tokens += msg.input + msg.cache_write;
    }
}

fn aggregate(
    arena: Allocator,
    bounds: Bounds,
    files: []const CachedFile,
    home: []const u8,
) !Aggregated {
    var agg = Aggregated{
        .periods = undefined,
        .hourly = Hourly.init(arena),
    };
    for (0..5) |pi| {
        agg.periods[pi] = .{
            .providers = std.StringHashMap(ProviderStats).init(arena),
            .raw = emptyRaw(arena),
        };
    }

    var seen_hashes = std.hash_map.HashMap(MsgKey, void, MsgKeyCtx, std.hash_map.default_max_load_percentage).init(arena);
    var seen_sessions = std.StringHashMap(void).init(arena);
    var cost_by_day = std.AutoHashMap(i64, f64).init(arena);

    for (files) |file| {
        if (file.session_id.len == 0) continue;
        const project = try projectLabelFromCwd(arena, file.cwd, home);

        var deduped = ManagedList(Message).init(arena);
        var metas = ManagedList(Meta).init(arena);
        var previous_assistant: ?Message = null;
        for (file.messages) |m| {
            const prev: ?Message = if (!m.auxiliary) previous_assistant else null;
            if (!m.auxiliary) previous_assistant = m;

            const fingerprint = m.input + m.output + m.cache_read + m.cache_write;
            const key = MsgKey{ .auxiliary = m.auxiliary, .source_id = m.source_id, .timestamp = m.timestamp, .fingerprint = fingerprint };
            if (seen_hashes.contains(key)) continue;
            try seen_hashes.put(key, {});

            var meta = Meta{};
            if (prev) |p| {
                if (p.timestamp > 0 and m.timestamp > 0) meta.gap_ms = m.timestamp - p.timestamp;
                meta.prev_ctx = p.input + p.cache_read + p.cache_write;
                meta.model_switched = !mem.eql(u8, p.provider, m.provider) or !mem.eql(u8, p.model, m.model);
            }
            try deduped.append(m);
            try metas.append(meta);
        }

        // The first deduped assistant message of a session marks its opening cost.
        var first_assistant: ?usize = null;
        for (deduped.items, 0..) |m, i| {
            if (!m.auxiliary) {
                first_assistant = i;
                break;
            }
        }
        if (first_assistant) |idx| {
            if (!seen_sessions.contains(file.session_id)) {
                try seen_sessions.put(file.session_id, {});
                metas.items[idx].is_session_start = true;
            }
        }

        var session_contributed = [5]bool{ false, false, false, false, false };
        for (deduped.items, 0..) |m, i| {
            try addMessage(arena, &agg, file.session_id, project, m, metas.items[i], bounds, &cost_by_day, &session_contributed);
        }
        for (0..5) |pi| {
            if (session_contributed[pi]) agg.periods[pi].totals.sessions += 1;
        }
    }

    // Burn trend: last 7 calendar days vs the average weekly pace of the prior 28.
    var last7: f64 = 0;
    var prior28: f64 = 0;
    var it = cost_by_day.iterator();
    while (it.next()) |entry| {
        if (entry.key_ptr.* >= -6) {
            last7 += entry.value_ptr.*;
        } else if (entry.key_ptr.* >= -34) {
            prior28 += entry.value_ptr.*;
        }
    }
    if (prior28 > 0) {
        agg.trend = .{ .last7_cost = last7, .prior_weekly_pace = prior28 / 4 };
    }
    return agg;
}

// =============================================================================
// Insights (text ported verbatim from the original extension)
// =============================================================================

fn fmtMoney(buf: *List, v: f64) !void {
    if (v >= 1000) {
        try buf.print("${d:.1}k", .{v / 1000});
    } else if (v >= 100) {
        try buf.print("${d}", .{@round(v)});
    } else {
        try buf.print("${d:.2}", .{v});
    }
}

fn fmtPercent(buf: *List, p: f64) !void {
    if (p >= 10) {
        try buf.print("{d}%", .{@round(p)});
    } else {
        try buf.print("{d:.1}%", .{p});
    }
}

fn fmtThresholdTokens(buf: *List, n: f64) !void {
    if (n >= 1_000_000) {
        try buf.print("{d}M", .{n / 1_000_000});
    } else if (n >= 1_000) {
        try buf.print("{d}k", .{n / 1_000});
    } else {
        try buf.print("{d}", .{n});
    }
}

fn computeInsights(arena: Allocator, raw: *const PeriodRaw, trend: ?Trend) ![]Insight {
    var list = ManagedList(Insight).init(arena);
    var tmp = List.init(arena);
    if (raw.total_cost <= 0) return list.toOwnedSlice();

    const total = raw.total_cost;
    const assistant_total = raw.assistant_cost;
    const assistant_pct_label = if (raw.auxiliary_cost > 0) "assistant-message cost" else "this period";

    const add = struct {
        fn f(arena2: Allocator, list2: *ManagedList(Insight), kind: []const u8, stat: []const u8, headline: []const u8, advice: []const u8) !void {
            try list2.append(.{
                .kind = try arena2.dupe(u8, kind),
                .stat = try arena2.dupe(u8, stat),
                .headline = try arena2.dupe(u8, headline),
                .advice = try arena2.dupe(u8, advice),
            });
        }
    }.f;
    const money = struct {
        fn f(arena2: Allocator, buf: *List, v: f64) ![]const u8 {
            buf.clearRetainingCapacity();
            try fmtMoney(buf, v);
            return try arena2.dupe(u8, buf.items);
        }
    }.f;
    const percent = struct {
        fn f(arena2: Allocator, buf: *List, p: f64) ![]const u8 {
            buf.clearRetainingCapacity();
            try fmtPercent(buf, p);
            return try arena2.dupe(u8, buf.items);
        }
    }.f;
    const threshold = struct {
        fn f(arena2: Allocator, buf: *List, n: f64) ![]const u8 {
            buf.clearRetainingCapacity();
            try fmtThresholdTokens(buf, n);
            return try arena2.dupe(u8, buf.items);
        }
    }.f;

    // --- Alarms ---

    const ttl_pct = if (assistant_total > 0) (raw.ttl_miss_cost / assistant_total) * 100 else 0;
    if (ttl_pct >= CACHE_MISS_ALARM_PERCENT and raw.ttl_miss_cost >= CACHE_MISS_ALARM_MIN_COST) {
        try add(arena, &list, "alarm", try money(arena, &tmp, raw.ttl_miss_cost), try std.fmt.allocPrint(arena, "spent resuming conversations after a break ({s} of {s})", .{ try percent(arena, &tmp, ttl_pct), assistant_pct_label }), "Sent context is only reusable for a few minutes. After a longer pause, the next message pays to send the whole conversation again. Replying while a session is fresh avoids this.");
    }

    const switch_pct = if (assistant_total > 0) (raw.switch_miss_cost / assistant_total) * 100 else 0;
    if (switch_pct >= CACHE_MISS_ALARM_PERCENT and raw.switch_miss_cost >= CACHE_MISS_ALARM_MIN_COST) {
        try add(arena, &list, "alarm", try money(arena, &tmp, raw.switch_miss_cost), try std.fmt.allocPrint(arena, "spent switching models mid-conversation ({s} of {s})", .{ try percent(arena, &tmp, switch_pct), assistant_pct_label }), "Changing model re-sends the whole conversation at full price — the previous model's saved context doesn't transfer. Switching between tasks instead of mid-conversation avoids this.");
    }

    const prefix_pct = if (assistant_total > 0) (raw.prefix_miss_cost / assistant_total) * 100 else 0;
    if (prefix_pct >= CACHE_MISS_ALARM_PERCENT and raw.prefix_miss_cost >= CACHE_MISS_ALARM_MIN_COST) {
        try add(arena, &list, "alarm", try money(arena, &tmp, raw.prefix_miss_cost), try std.fmt.allocPrint(arena, "spent re-sending conversations mid-session ({s} of {s})", .{ try percent(arena, &tmp, prefix_pct), assistant_pct_label }), "These messages paid full price for context that had already been sent — with no break, compaction, or model switch to explain it. Usually a tool or workflow is restarting or rewriting conversations. Worth a look if it stays high.");
    }

    if (raw.session_costs.count() > TOP_SESSION_COUNT) {
        var values = ManagedList(f64).init(arena);
        var it = raw.session_costs.valueIterator();
        while (it.next()) |v| try values.append(v.*);
        std.mem.sort(f64, values.items, {}, struct {
            fn lt(_: void, a: f64, b: f64) bool {
                return a > b;
            }
        }.lt);
        var top_weight: f64 = 0;
        for (values.items[0..TOP_SESSION_COUNT]) |c| top_weight += c;
        const top_pct = (top_weight / total) * 100;
        if (top_pct >= CONCENTRATION_ALARM_PERCENT) {
            try add(arena, &list, "alarm", try money(arena, &tmp, top_weight), try std.fmt.allocPrint(arena, "came from just {d} of your {d} sessions ({s} of this period)", .{ TOP_SESSION_COUNT, raw.session_costs.count(), try percent(arena, &tmp, top_pct) }), "A handful of sessions drove most of the spend. The graph view can show what they were doing.");
        }
    }

    const upfront_pct = if (assistant_total > 0) (raw.upfront_cost / assistant_total) * 100 else 0;
    if (upfront_pct >= UPFRONT_ALARM_PERCENT) {
        try add(arena, &list, "alarm", try money(arena, &tmp, raw.upfront_cost), try std.fmt.allocPrint(arena, "spent on the opening message of new sessions ({s} of {s})", .{ try percent(arena, &tmp, upfront_pct), assistant_pct_label }), "A session's first message sends everything from scratch. Fewer, longer sessions cut this overhead.");
    }

    if (assistant_total >= LEVERAGE_MIN_COST and raw.fresh_tokens >= LEVERAGE_MIN_FRESH_TOKENS) {
        const leverage = raw.cache_read_tokens / raw.fresh_tokens;
        if (leverage < LEVERAGE_FLOOR) {
            var stat_buf: [16]u8 = undefined;
            const stat = std.fmt.bufPrint(&stat_buf, "{d:.1}×", .{leverage}) catch "0×";
            try add(arena, &list, "alarm", stat, "tokens reused from history for every token paid at full price", "Typical interactive use reuses 10× or more. A low number means conversations keep being sent from scratch — look for workflows that restart sessions.");
        }
    }

    // --- Structure ---

    if (raw.auxiliary_cost > 0) {
        const pct = (raw.auxiliary_cost / total) * 100;
        if (pct >= 1) {
            try add(arena, &list, "structure", try percent(arena, &tmp, pct), "of your cost came from usage reported by tools and conversation summaries", "Pi records this separately because it cannot be attributed reliably to a specific provider and model.");
        }
    }

    if (raw.ctx_high.messages > 0 and assistant_total > 0) {
        const pct = (raw.ctx_high.cost / assistant_total) * 100;
        if (pct >= 1) {
            const avg_high = raw.ctx_high.cost / @as(f64, @floatFromInt(raw.ctx_high.messages));
            const avg_low = if (raw.ctx_low.messages > 0) raw.ctx_low.cost / @as(f64, @floatFromInt(raw.ctx_low.messages)) else 0;
            var cmp_buf = List.init(arena);
            if (avg_low > 0) {
                try cmp_buf.appendSlice(" — ");
                try fmtMoney(&cmp_buf, avg_high);
                try cmp_buf.appendSlice("/msg vs ");
                try fmtMoney(&cmp_buf, avg_low);
                try cmp_buf.appendSlice(" under ");
                try fmtThresholdTokens(&cmp_buf, CTX_LOW_THRESHOLD);
            }
            const base = if (raw.auxiliary_cost > 0) "assistant-message cost" else "cost";
            try add(arena, &list, "structure", try percent(arena, &tmp, pct), try std.fmt.allocPrint(arena, "of your {s} came from messages with ≥{s} tokens loaded{s}", .{ base, try threshold(arena, &tmp, CTX_TAX_THRESHOLD), cmp_buf.items }), "Long conversations cost more per message. /compact mid-task and /clear between tasks keep them lean.");
        }
    }

    if (raw.project_costs.count() >= 2) {
        const Entry = struct { label: []const u8, cost: f64 };
        var entries = ManagedList(Entry).init(arena);
        var it = raw.project_costs.iterator();
        while (it.next()) |e| try entries.append(.{ .label = e.key_ptr.*, .cost = e.value_ptr.* });
        std.mem.sort(Entry, entries.items, {}, struct {
            fn lt(_: void, a: Entry, b: Entry) bool {
                return a.cost > b.cost;
            }
        }.lt);
        const top_count = @min(PROJECT_TOP_COUNT, entries.items.len);
        const top = entries.items[0..top_count];
        const top_pct = (top[0].cost / total) * 100;
        if (top_pct < PROJECT_MAX_DOMINANCE_PERCENT) {
            var rest_buf = List.init(arena);
            for (top[1..]) |e| {
                if (rest_buf.items.len > 0) try rest_buf.appendSlice(", ");
                try rest_buf.appendSlice(e.label);
                try rest_buf.appendSlice(" ");
                try fmtPercent(&rest_buf, (e.cost / total) * 100);
            }
            var headline_buf = List.init(arena);
            try headline_buf.appendSlice("of your cost was ");
            try headline_buf.appendSlice(top[0].label);
            if (rest_buf.items.len > 0) {
                try headline_buf.appendSlice(" — then ");
                try headline_buf.appendSlice(rest_buf.items);
            }
            try add(arena, &list, "structure", try percent(arena, &tmp, top_pct), try arena.dupe(u8, headline_buf.items), "");
        }
    }

    if (raw.output_tokens > 0) {
        const reasoning_pct = (raw.reasoning_tokens / raw.output_tokens) * 100;
        if (reasoning_pct >= REASONING_MIN_PERCENT) {
            try add(arena, &list, "structure", try percent(arena, &tmp, reasoning_pct), "of your output tokens were hidden reasoning", "Models charge for their behind-the-scenes thinking as output tokens. pi records this only from 0.80.3 (June 2026), so older periods understate it.");
        }
    }

    if (trend) |t| {
        if (t.prior_weekly_pace > 0) {
            const ratio = t.last7_cost / t.prior_weekly_pace;
            const advice = if (ratio >= TREND_HIGH_RATIO)
                "Spending is up against your own baseline — the graph view shows what changed."
            else if (ratio <= TREND_LOW_RATIO)
                "Spending is well below your recent baseline."
            else
                "";
            var stat_buf: [16]u8 = undefined;
            const stat = std.fmt.bufPrint(&stat_buf, "{d:.1}×", .{ratio}) catch "0×";
            var last7_buf = List.init(arena);
            try fmtMoney(&last7_buf, t.last7_cost);
            var pace_buf = List.init(arena);
            try fmtMoney(&pace_buf, t.prior_weekly_pace);
            try add(arena, &list, "structure", stat, try std.fmt.allocPrint(arena, "your last 7 days ({s}) vs your prior 4-week pace ({s}/wk)", .{ last7_buf.items, pace_buf.items }), advice);
        }
    }

    return list.toOwnedSlice();
}

// =============================================================================
// JSON output
// =============================================================================

const Out = struct { buf: *List };

fn wstr(o: *Out, s: []const u8) !void {
    try o.buf.append('"');
    try appendJsonEscaped(o.buf, s);
    try o.buf.append('"');
}

fn wnum(o: *Out, v: f64) !void {
    if (v == @trunc(v) and @abs(v) < 9.007199254740992e15) {
        try o.buf.print("{d}", .{@as(i64, @intFromFloat(v))});
    } else {
        try o.buf.print("{d}", .{v});
    }
}

fn wkey(o: *Out, s: []const u8) !void {
    try wstr(o, s);
    try o.buf.append(':');
}

fn writeTokens(o: *Out, t: TokenStats) !void {
    try o.buf.appendSlice("{\"total\":");
    try wnum(o, t.total);
    try o.buf.appendSlice(",\"input\":");
    try wnum(o, t.input);
    try o.buf.appendSlice(",\"output\":");
    try wnum(o, t.output);
    try o.buf.appendSlice(",\"cacheRead\":");
    try wnum(o, t.cache_read);
    try o.buf.appendSlice(",\"cacheWrite\":");
    try wnum(o, t.cache_write);
    try o.buf.append('}');
}

const CostEntry = struct { key: []const u8, cost: f64 };

const CostEntryCtx = struct {
    fn byCostDesc(_: CostEntryCtx, a: CostEntry, b: CostEntry) bool {
        if (a.cost != b.cost) return a.cost > b.cost;
        return mem.lessThan(u8, a.key, b.key);
    }
};

fn writeModelStats(o: *Out, m: *const ModelStats) !void {
    try o.buf.appendSlice("{\"messages\":");
    try o.buf.print("{d}", .{m.messages});
    try o.buf.appendSlice(",\"cost\":");
    try wnum(o, m.cost);
    try o.buf.appendSlice(",\"sessions\":");
    try o.buf.print("{d}", .{m.sessions.count()});
    try o.buf.appendSlice(",\"tokens\":");
    try writeTokens(o, m.tokens);
    try o.buf.append('}');
}

fn writeProviderStats(o: *Out, p: *const ProviderStats) !void {
    try o.buf.appendSlice("{\"messages\":");
    try o.buf.print("{d}", .{p.messages});
    try o.buf.appendSlice(",\"cost\":");
    try wnum(o, p.cost);
    try o.buf.appendSlice(",\"sessions\":");
    try o.buf.print("{d}", .{p.sessions.count()});
    try o.buf.appendSlice(",\"tokens\":");
    try writeTokens(o, p.tokens);
    try o.buf.appendSlice(",\"models\":{");
    var entries = ManagedList(CostEntry).init(o.buf.allocator);
    var it = p.models.iterator();
    while (it.next()) |e| {
        try entries.append(.{ .key = e.key_ptr.*, .cost = e.value_ptr.cost });
    }
    std.mem.sort(CostEntry, entries.items, CostEntryCtx{}, CostEntryCtx.byCostDesc);
    for (entries.items, 0..) |e, i| {
        if (i > 0) try o.buf.append(',');
        try wkey(o, e.key);
        try writeModelStats(o, p.models.getPtr(e.key).?);
    }
    try o.buf.appendSlice("}}");
}

fn writePeriod(o: *Out, p: *const Period) !void {
    try o.buf.appendSlice("{\"providers\":{");
    var entries = ManagedList(CostEntry).init(o.buf.allocator);
    var it = p.providers.iterator();
    while (it.next()) |e| {
        try entries.append(.{ .key = e.key_ptr.*, .cost = e.value_ptr.cost });
    }
    std.mem.sort(CostEntry, entries.items, CostEntryCtx{}, CostEntryCtx.byCostDesc);
    for (entries.items, 0..) |e, i| {
        if (i > 0) try o.buf.append(',');
        try wkey(o, e.key);
        try writeProviderStats(o, p.providers.getPtr(e.key).?);
    }
    try o.buf.appendSlice("},\"totals\":{\"sessions\":");
    try o.buf.print("{d}", .{p.totals.sessions});
    try o.buf.appendSlice(",\"messages\":");
    try o.buf.print("{d}", .{p.totals.messages});
    try o.buf.appendSlice(",\"cost\":");
    try wnum(o, p.totals.cost);
    try o.buf.appendSlice(",\"tokens\":");
    try writeTokens(o, p.totals.tokens);
    try o.buf.appendSlice("},\"insights\":{\"insights\":[");
    for (p.insights, 0..) |ins, i| {
        if (i > 0) try o.buf.append(',');
        try o.buf.appendSlice("{\"kind\":");
        try wstr(o, ins.kind);
        try o.buf.appendSlice(",\"stat\":");
        try wstr(o, ins.stat);
        try o.buf.appendSlice(",\"headline\":");
        try wstr(o, ins.headline);
        try o.buf.appendSlice(",\"advice\":");
        try wstr(o, ins.advice);
        try o.buf.append('}');
    }
    try o.buf.appendSlice("]}}");
}

fn buildUsageJson(arena: Allocator, agg: *Aggregated, bounds: Bounds, warnings: []const []const u8) ![]const u8 {
    var buf = List.init(arena);
    var o = Out{ .buf = &buf };
    try buf.appendSlice("{\"bounds\":{\"todayMs\":");
    try wnum(&o, bounds.todayMs);
    try buf.appendSlice(",\"weekStartMs\":");
    try wnum(&o, bounds.weekStartMs);
    try buf.appendSlice(",\"lastWeekStartMs\":");
    try wnum(&o, bounds.lastWeekStartMs);
    try buf.appendSlice(",\"last30DaysStartMs\":");
    try wnum(&o, bounds.last30DaysStartMs);
    try buf.appendSlice(",\"nowMs\":");
    try wnum(&o, bounds.nowMs);
    try buf.appendSlice("},\"hourly\":{");

    // Hours ascending for a deterministic payload.
    var hours = ManagedList(i64).init(arena);
    var hit = agg.hourly.keyIterator();
    while (hit.next()) |h| try hours.append(h.*);
    std.mem.sort(i64, hours.items, {}, struct {
        fn lt(_: void, a: i64, b: i64) bool {
            return a < b;
        }
    }.lt);
    for (hours.items, 0..) |hour, hi| {
        if (hi > 0) try buf.append(',');
        try wstr(&o, try std.fmt.allocPrint(arena, "{d}", .{hour}));
        try buf.append(':');
        try buf.append('{');
        const bucket = agg.hourly.get(hour).?;
        var first = true;
        var bit = bucket.iterator();
        while (bit.next()) |e| {
            if (!first) try buf.append(',');
            first = false;
            try wkey(&o, e.key_ptr.*);
            try buf.appendSlice("[");
            try buf.print("{d},", .{e.value_ptr.messages});
            try wnum(&o, e.value_ptr.cost);
            try buf.append(',');
            try wnum(&o, e.value_ptr.input);
            try buf.append(',');
            try wnum(&o, e.value_ptr.output);
            try buf.append(',');
            try wnum(&o, e.value_ptr.cache_read);
            try buf.append(',');
            try wnum(&o, e.value_ptr.cache_write);
            try buf.append(',');
            try wnum(&o, e.value_ptr.reasoning);
            try buf.append(']');
        }
        try buf.append('}');
    }
    try buf.appendSlice("},\"today\":");
    try writePeriod(&o, &agg.periods[0]);
    try buf.appendSlice(",\"thisWeek\":");
    try writePeriod(&o, &agg.periods[1]);
    try buf.appendSlice(",\"lastWeek\":");
    try writePeriod(&o, &agg.periods[2]);
    try buf.appendSlice(",\"last30Days\":");
    try writePeriod(&o, &agg.periods[3]);
    try buf.appendSlice(",\"allTime\":");
    try writePeriod(&o, &agg.periods[4]);
    // Scan warnings: files that could not be stat/read/parsed (their cached
    // rows were retained), so a partial scan is never reported as clean.
    try buf.appendSlice(",\"warnings\":[");
    for (warnings, 0..) |w, i| {
        if (i > 0) try buf.append(',');
        try wstr(&o, w);
    }
    try buf.appendSlice("]");
    try buf.append('}');
    return buf.items;
}

// =============================================================================
// Provider limits (OpenCode Go + OpenAI Codex)
// =============================================================================

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_WHAM_PATH = "wham/usage";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const USER_AGENT = "pi-usage/1.0";

const http = std.http;

fn httpGet(arena: Allocator, io: std.Io, url: []const u8, auth: ?[]const u8, extra: []const http.Header) ![]const u8 {
    var client: std.http.Client = .{ .allocator = arena, .io = io };
    defer client.deinit();
    var body_list: std.ArrayList(u8) = .empty;
    var aw = std.Io.Writer.Allocating.fromArrayList(arena, &body_list);
    const result = try client.fetch(.{
        .location = .{ .url = url },
        .method = .GET,
        .headers = .{
            .authorization = if (auth) |a| .{ .override = a } else .omit,
            .user_agent = .{ .override = USER_AGENT },
        },
        .extra_headers = extra,
        .response_writer = &aw.writer,
    });
    if (result.status != .ok) return error.HttpStatus;
    const body = aw.toArrayList();
    return body.items;
}

const LimitWindow = struct {
    id: []const u8,
    label: []const u8,
    duration_ms: ?f64,
    resets_at: ?f64,
};

const Limit = struct {
    id: []const u8,
    label: []const u8,
    window_id: []const u8,
    window_label: []const u8,
    duration_ms: ?f64,
    resets_at: ?f64,
    used: ?f64,
    used_fraction: ?f64,
    remaining_fraction: ?f64,
    status: []const u8, // ok | warning | exhausted | unknown
};

const ProviderLimits = struct {
    provider: []const u8,
    err: ?[]const u8 = null,
    email: ?[]const u8 = null,
    plan_type: ?[]const u8 = null,
    account_id: ?[]const u8 = null,
    reset_credits: ?u64 = null,
    limits: []Limit = &.{},
};

fn writeLimitsJson(arena: Allocator, providers: []const ProviderLimits, fetched_at: f64) ![]const u8 {
    var buf = List.init(arena);
    var o = Out{ .buf = &buf };
    try buf.appendSlice("{\"fetchedAt\":");
    try wnum(&o, fetched_at);
    try buf.appendSlice(",\"providers\":[");
    for (providers, 0..) |p, i| {
        if (i > 0) try buf.append(',');
        try buf.appendSlice("{\"provider\":");
        try wstr(&o, p.provider);
        try buf.appendSlice(",\"error\":");
        if (p.err) |err| {
            try wstr(&o, err);
        } else {
            try buf.appendSlice("null");
        }
        try buf.appendSlice(",\"account\":{");
        var first = true;
        if (p.email) |email| {
            if (!first) try buf.append(',');
            first = false;
            try wkey(&o, "email");
            try wstr(&o, email);
        }
        if (p.plan_type) |pt| {
            if (!first) try buf.append(',');
            first = false;
            try wkey(&o, "planType");
            try wstr(&o, pt);
        }
        if (p.account_id) |aid| {
            if (!first) try buf.append(',');
            first = false;
            try wkey(&o, "accountId");
            try wstr(&o, aid);
        }
        try buf.appendSlice("},\"resetCredits\":");
        if (p.reset_credits) |rc| {
            try buf.print("{d}", .{rc});
        } else {
            try buf.appendSlice("null");
        }
        try buf.appendSlice(",\"limits\":[");
        for (p.limits, 0..) |l, li| {
            if (li > 0) try buf.append(',');
            try buf.appendSlice("{\"id\":");
            try wstr(&o, l.id);
            try buf.appendSlice(",\"label\":");
            try wstr(&o, l.label);
            try buf.appendSlice(",\"windowId\":");
            try wstr(&o, l.window_id);
            try buf.appendSlice(",\"windowLabel\":");
            try wstr(&o, l.window_label);
            try buf.appendSlice(",\"durationMs\":");
            if (l.duration_ms) |d| {
                try wnum(&o, d);
            } else {
                try buf.appendSlice("null");
            }
            try buf.appendSlice(",\"resetsAt\":");
            if (l.resets_at) |r| {
                try wnum(&o, r);
            } else {
                try buf.appendSlice("null");
            }
            try buf.appendSlice(",\"used\":");
            if (l.used) |u| {
                try wnum(&o, u);
            } else {
                try buf.appendSlice("null");
            }
            try buf.appendSlice(",\"usedFraction\":");
            if (l.used_fraction) |uf| {
                try wnum(&o, uf);
            } else {
                try buf.appendSlice("null");
            }
            try buf.appendSlice(",\"remainingFraction\":");
            if (l.remaining_fraction) |rf| {
                try wnum(&o, rf);
            } else {
                try buf.appendSlice("null");
            }
            try buf.appendSlice(",\"status\":");
            try wstr(&o, l.status);
            try buf.append('}');
        }
        try buf.appendSlice("]}");
    }
    try buf.appendSlice("]}");
    return buf.items;
}

fn buildOpenCodeLimits(arena: Allocator, io: std.Io, api_key: ?[]const u8) !ProviderLimits {
    var result = ProviderLimits{ .provider = "opencode-go" };
    const key = api_key orelse {
        result.err = "OPENCODE_API_KEY is not set";
        return result;
    };
    if (key.len == 0) {
        result.err = "OPENCODE_API_KEY is not set";
        return result;
    }
    const auth = std.fmt.allocPrint(arena, "Bearer {s}", .{key}) catch {
        result.err = "out of memory";
        return result;
    };
    const body = httpGet(arena, io, OPENCODE_USAGE_URL, auth, &.{}) catch |err| {
        result.err = try std.fmt.allocPrint(arena, "usage fetch failed ({s})", .{@errorName(err)});
        return result;
    };
    const parsed = json.parseFromSlice(json.Value, arena, body, .{}) catch {
        result.err = "usage response was not valid JSON";
        return result;
    };
    if (parsed.value != .object) {
        result.err = "usage response had no payload";
        return result;
    }
    const usage_value = parsed.value.object.get("usage") orelse {
        result.err = "usage response had no usage object";
        return result;
    };
    if (usage_value != .object) {
        result.err = "usage response had no usage object";
        return result;
    }
    const usage = usage_value.object;

    const descriptors = [_]struct {
        key: []const u8,
        id: []const u8,
        limit_label: []const u8,
        window_label: []const u8,
        duration_ms: ?f64,
    }{
        .{ .key = "rolling", .id = "5h", .limit_label = "5 Hour limit", .window_label = "5 Hour", .duration_ms = 5 * HOUR_MS },
        .{ .key = "weekly", .id = "7d", .limit_label = "Weekly limit", .window_label = "Weekly", .duration_ms = 7 * DAY_MS },
        .{ .key = "monthly", .id = "monthly", .limit_label = "Monthly limit", .window_label = "Monthly", .duration_ms = null },
    };

    var limits = ManagedList(Limit).init(arena);
    for (descriptors) |d| {
        const window_value = usage.get(d.key) orelse {
            result.err = "usage response missing a window";
            return result;
        };
        if (window_value != .object) {
            result.err = "usage response window was malformed";
            return result;
        }
        const w = window_value.object;
        const percent_value = w.get("percent") orelse {
            result.err = "usage response window was malformed";
            return result;
        };
        const percent: f64 = switch (percent_value) {
            .integer => |i| @floatFromInt(i),
            .float => |f| f,
            else => {
                result.err = "usage response window was malformed";
                return result;
            },
        };
        if (percent < 0 or percent > 100) {
            result.err = "usage response window was malformed";
            return result;
        }
        const status_str = asStr(w.get("status")) orelse "ok";
        const resets_at: ?f64 = blk: {
            const iso = asStr(w.get("resetsAt")) orelse break :blk null;
            const ms = parseIsoMs(iso);
            break :blk if (ms > 0) ms else null;
        };
        const used_fraction = percent / 100;
        const status = if (mem.eql(u8, status_str, "rate-limited"))
            "exhausted"
        else if (used_fraction >= 1)
            "exhausted"
        else if (used_fraction >= 0.8)
            "warning"
        else
            "ok";
        try limits.append(.{
            .id = try std.fmt.allocPrint(arena, "opencode-go:{s}", .{d.key}),
            .label = d.limit_label,
            .window_id = d.id,
            .window_label = d.window_label,
            .duration_ms = d.duration_ms,
            .resets_at = resets_at,
            .used = percent,
            .used_fraction = used_fraction,
            .remaining_fraction = @max(0, 1 - used_fraction),
            .status = status,
        });
    }
    result.plan_type = "OpenCode Go";
    result.limits = try limits.toOwnedSlice();
    return result;
}

fn buildWindowLabel(arena: Allocator, seconds: f64) struct { id: []const u8, label: []const u8 } {
    const day_seconds: f64 = 86_400;
    if (seconds >= day_seconds) {
        const days: u64 = @intFromFloat(@round(seconds / day_seconds));
        const id = std.fmt.allocPrint(arena, "{d}d", .{days}) catch "d";
        const label = if (days == 1) "1 day" else std.fmt.allocPrint(arena, "{d} days", .{days}) catch "days";
        return .{ .id = id, .label = label };
    }
    const hours: u64 = @intFromFloat(@max(1, @round(seconds / 3600)));
    const id = std.fmt.allocPrint(arena, "{d}h", .{hours}) catch "h";
    const label = if (hours == 1) "1 hour" else std.fmt.allocPrint(arena, "{d} hours", .{hours}) catch "hours";
    return .{ .id = id, .label = label };
}

const CodexWindow = struct {
    used_percent: ?f64 = null,
    window_seconds: ?f64 = null,
    reset_after_seconds: ?f64 = null,
    reset_at: ?f64 = null,
};

fn parseCodexWindow(v: ?json.Value) ?CodexWindow {
    const w = v orelse return null;
    if (w != .object) return null;
    const obj = w.object;
    const result = CodexWindow{
        .used_percent = if (obj.get("used_percent") != null) asNum(obj.get("used_percent")) else null,
        .window_seconds = if (obj.get("limit_window_seconds") != null) asNum(obj.get("limit_window_seconds")) else null,
        .reset_after_seconds = if (obj.get("reset_after_seconds") != null) asNum(obj.get("reset_after_seconds")) else null,
        .reset_at = if (obj.get("reset_at") != null) asNum(obj.get("reset_at")) else null,
    };
    if (result.used_percent == null and result.window_seconds == null and result.reset_after_seconds == null and result.reset_at == null) return null;
    return result;
}

fn resolveCodexResetAt(w: CodexWindow, now: f64) ?f64 {
    if (w.reset_at) |at| {
        const ms = if (at > 1_000_000_000_000) at else at * 1000;
        if (std.math.isFinite(ms)) return ms;
    }
    if (w.reset_after_seconds) |s| {
        return now + s * 1000;
    }
    return null;
}

fn buildCodexLimit(
    arena: Allocator,
    key: []const u8,
    w: CodexWindow,
    now: f64,
    explicitly_allowed: bool,
) !Limit {
    var window_id: []const u8 = key;
    var window_label: []const u8 = if (mem.eql(u8, key, "primary")) "Primary window" else "Secondary window";
    var duration_ms: ?f64 = null;
    if (w.window_seconds) |s| {
        const wl = buildWindowLabel(arena, s);
        window_id = wl.id;
        window_label = wl.label;
        duration_ms = s * 1000;
    }
    const used_fraction: ?f64 = if (w.used_percent) |p| blk: {
        const clamped = @min(@max(p, 0), 100);
        break :blk clamped / 100;
    } else null;
    const status = if (used_fraction) |uf|
        if (uf >= 1)
            if (explicitly_allowed) "warning" else "exhausted"
        else if (uf >= 0.9)
            "warning"
        else
            "ok"
    else
        "unknown";
    return .{
        .id = try std.fmt.allocPrint(arena, "openai-codex:{s}", .{key}),
        .label = window_label,
        .window_id = window_id,
        .window_label = window_label,
        .duration_ms = duration_ms,
        .resets_at = resolveCodexResetAt(w, now),
        .used = w.used_percent,
        .used_fraction = used_fraction,
        .remaining_fraction = if (used_fraction) |uf| @max(0, 1 - uf) else null,
        .status = status,
    };
}

fn additionalLimitSlug(arena: Allocator, limit_name: ?[]const u8, metered_feature: ?[]const u8) []const u8 {
    const probe = std.fmt.allocPrint(arena, "{s} {s}", .{ limit_name orelse "", metered_feature orelse "" }) catch return "extra";
    var lower = ManagedList(u8).init(arena);
    for (probe) |c| lower.append(std.ascii.toLower(c)) catch {};
    if (std.mem.indexOf(u8, lower.items, "spark") != null or std.mem.indexOf(u8, lower.items, "bengalfox") != null) {
        return "spark";
    }
    const source = metered_feature orelse limit_name orelse "extra";
    var out = ManagedList(u8).init(arena);
    for (source) |c| {
        if (std.ascii.isAlphanumeric(c)) out.append(std.ascii.toLower(c)) catch {};
    }
    var slug = std.mem.trim(u8, out.items, "-");
    if (std.mem.startsWith(u8, slug, "codex")) slug = slug[5..];
    if (slug.len == 0) return "extra";
    return slug;
}

fn additionalDisplayName(arena: Allocator, slug: []const u8, limit_name: ?[]const u8) []const u8 {
    if (mem.eql(u8, slug, "spark")) return "Spark";
    if (limit_name) |ln| return ln;
    // Title-case the slug.
    var out = ManagedList(u8).init(arena);
    var cap_next = true;
    for (slug) |c| {
        if (c == '-') {
            out.append(' ') catch {};
            cap_next = true;
        } else if (cap_next) {
            out.append(std.ascii.toUpper(c)) catch {};
            cap_next = false;
        } else {
            out.append(c) catch {};
        }
    }
    return out.items;
}

fn buildCodexLimits(arena: Allocator, io: std.Io, access_token: ?[]const u8, account_id: ?[]const u8, email: ?[]const u8, now: f64) !ProviderLimits {
    var result = ProviderLimits{ .provider = "openai-codex" };

    // The access token and account id are resolved by the glue through pi's
    // model registry (getApiKeyAndHeaders), which owns refresh and auth.json
    // rewriting; this backend never touches the credential file.
    const token = mem.trim(u8, access_token orelse "", " \t\r\n");
    if (token.len == 0) {
        result.err = "no openai-codex credentials; log in with /login";
        return result;
    }

    // --- Fetch wham/usage ---
    const auth_header = std.fmt.allocPrint(arena, "Bearer {s}", .{token}) catch {
        result.err = "usage fetch failed";
        return result;
    };
    var extra: [1]http.Header = undefined;
    var extra_count: usize = 0;
    if (account_id) |aid| {
        if (aid.len > 0) {
            extra[0] = .{ .name = "ChatGPT-Account-Id", .value = aid };
            extra_count = 1;
        }
    }
    const url = std.fmt.allocPrint(arena, "{s}/{s}", .{ CODEX_BASE_URL, CODEX_WHAM_PATH }) catch {
        result.err = "usage fetch failed";
        return result;
    };
    const body = httpGet(arena, io, url, auth_header, extra[0..extra_count]) catch |err| {
        result.err = try std.fmt.allocPrint(arena, "usage fetch failed ({s})", .{@errorName(err)});
        return result;
    };
    const parsed = json.parseFromSlice(json.Value, arena, body, .{}) catch {
        result.err = "usage response was not valid JSON";
        return result;
    };
    if (parsed.value != .object) {
        result.err = "usage response had no payload";
        return result;
    }
    const payload = parsed.value.object;

    result.plan_type = asStr(payload.get("plan_type"));
    result.email = email;
    result.account_id = account_id;

    // Saved rate-limit resets.
    if (payload.get("rate_limit_reset_credits")) |rc| {
        if (rc == .object) {
            const rc_obj = rc.object;
            if (rc_obj.get("available_count") != null) {
                const count = asNum(rc_obj.get("available_count"));
                if (count >= 0) result.reset_credits = @intFromFloat(count);
            }
        }
    }

    var limits = ManagedList(Limit).init(arena);
    const rate_limit = payload.get("rate_limit");
    const allowed: ?bool = if (rate_limit != null and rate_limit.? == .object) asBool(rate_limit.?.object.get("allowed")) else null;
    const limit_reached: ?bool = if (rate_limit != null and rate_limit.? == .object) asBool(rate_limit.?.object.get("limit_reached")) else null;
    const explicitly_allowed = allowed == true and limit_reached == false;
    if (rate_limit != null and rate_limit.? == .object) {
        const rl = rate_limit.?.object;
        if (parseCodexWindow(rl.get("primary_window"))) |w| {
            try limits.append(try buildCodexLimit(arena, "primary", w, now, explicitly_allowed));
        }
        if (parseCodexWindow(rl.get("secondary_window"))) |w| {
            try limits.append(try buildCodexLimit(arena, "secondary", w, now, explicitly_allowed));
        }
    }

    // Additional metered features (e.g. Spark).
    if (payload.get("additional_rate_limits")) |arl| {
        if (arl == .array) {
            for (arl.array.items) |item| {
                if (item != .object) continue;
                const extra_obj = item.object;
                const limit_name = asStr(extra_obj.get("limit_name"));
                const metered_feature = asStr(extra_obj.get("metered_feature"));
                const rl2_value = extra_obj.get("rate_limit") orelse continue;
                if (rl2_value != .object) continue;
                const rl2 = rl2_value.object;
                const extra_allowed = asBool(rl2.get("allowed"));
                const extra_reached = asBool(rl2.get("limit_reached"));
                const extra_explicit = extra_allowed == true and extra_reached == false;
                const slug = additionalLimitSlug(arena, limit_name, metered_feature);
                const display = additionalDisplayName(arena, slug, limit_name);
                if (parseCodexWindow(rl2.get("primary_window"))) |w| {
                    var l = try buildCodexLimit(arena, "primary", w, now, extra_explicit);
                    l.id = try std.fmt.allocPrint(arena, "openai-codex:{s}:primary", .{slug});
                    l.label = try std.fmt.allocPrint(arena, "{s} ({s})", .{ l.window_label, display });
                    try limits.append(l);
                }
                if (parseCodexWindow(rl2.get("secondary_window"))) |w| {
                    var l = try buildCodexLimit(arena, "secondary", w, now, extra_explicit);
                    l.id = try std.fmt.allocPrint(arena, "openai-codex:{s}:secondary", .{slug});
                    l.label = try std.fmt.allocPrint(arena, "{s} ({s})", .{ l.window_label, display });
                    try limits.append(l);
                }
            }
        }
    }

    if (limits.items.len == 0) {
        result.err = "usage response had no rate-limit windows";
        return result;
    }
    result.limits = try limits.toOwnedSlice();
    return result;
}

fn buildLimitsJson(arena: Allocator, io: std.Io, environ: *std.process.Environ.Map, codex_access: ?[]const u8, codex_account_id: ?[]const u8, codex_email: ?[]const u8) ![]const u8 {
    const now = @as(f64, @floatFromInt(nowRealtimeMs()));
    const api_key = environ.get("OPENCODE_API_KEY");

    const codex = buildCodexLimits(arena, io, codex_access, codex_account_id, codex_email, now) catch |err| blk: {
        var p = ProviderLimits{ .provider = "openai-codex" };
        p.err = @errorName(err);
        break :blk p;
    };
    const opencode = buildOpenCodeLimits(arena, io, api_key) catch |err| blk: {
        var p = ProviderLimits{ .provider = "opencode-go" };
        p.err = @errorName(err);
        break :blk p;
    };

    var providers = ManagedList(ProviderLimits).init(arena);
    try providers.append(codex);
    try providers.append(opencode);
    return writeLimitsJson(arena, try providers.toOwnedSlice(), now);
}

// =============================================================================
// Collect orchestration
// =============================================================================

fn collectJsonlFiles(io: std.Io, arena: Allocator, dir_path: []const u8, out: *ManagedList([]const u8), warnings: *ManagedList([]const u8)) !void {
    var dir = std.Io.Dir.openDir(.cwd(), io, dir_path, .{ .iterate = true }) catch {
        // An unreadable sessions dir would otherwise surface as zero usage.
        try warnings.append(try std.fmt.allocPrint(arena, "could not open {s}", .{dir_path}));
        return;
    };
    defer dir.close(io);
    var it = dir.iterate();
    while (it.next(io) catch |err| blk: {
        try warnings.append(try std.fmt.allocPrint(arena, "session scan error in {s} ({s})", .{ dir_path, @errorName(err) }));
        break :blk null;
    }) |entry| {
        const full = try std.fmt.allocPrint(arena, "{s}/{s}", .{ dir_path, entry.name });
        switch (entry.kind) {
            .directory => try collectJsonlFiles(io, arena, full, out, warnings),
            .file => {
                if (std.mem.endsWith(u8, entry.name, ".jsonl")) try out.append(full);
            },
            else => {},
        }
    }
}

const Request = struct {
    op: []const u8,
    bounds: ?Bounds = null,
    agent_dir: ?[]const u8 = null, // required by collect; resolved by the glue
    codex_access: ?[]const u8 = null, // resolved by the glue via the model registry
    codex_account_id: ?[]const u8 = null,
    codex_email: ?[]const u8 = null,
};

fn runCollect(arena: Allocator, io: std.Io, environ: *std.process.Environ.Map, agent_dir: []const u8, bounds: Bounds) ![]const u8 {
    const sessions_dir = try std.fmt.allocPrint(arena, "{s}/sessions", .{agent_dir});
    const cache_path = try std.fmt.allocPrint(arena, "{s}/pi-usage-cache.bin", .{agent_dir});
    const home = environ.get("HOME") orelse "";

    // 1. Discover and stat session files.
    var file_paths = ManagedList([]const u8).init(arena);
    var warnings = ManagedList([]const u8).init(arena);
    try collectJsonlFiles(io, arena, sessions_dir, &file_paths, &warnings);
    std.mem.sort([]const u8, file_paths.items, {}, struct {
        fn lt(_: void, a: []const u8, b: []const u8) bool {
            return mem.lessThan(u8, a, b);
        }
    }.lt);

    // 2. Load the cache and decide which files need parsing. A file that
    //    fails to stat, read, or parse keeps its cached rows (stale but
    //    better than silently missing) and is reported in the warnings, so a
    //    partial scan is never persisted as success.
    const previous = try loadCache(io, arena, cache_path);
    var current = ManagedList(CachedFile).init(arena);
    var dirty = false;
    const appendCachedFallback = struct {
        fn f(current2: *ManagedList(CachedFile), previous2: *const Cache, path: []const u8) !void {
            if (previous2.files.get(path)) |cached| try current2.append(cached);
        }
    }.f;
    for (file_paths.items) |path| {
        const st = std.Io.Dir.statFile(.cwd(), io, path, .{}) catch {
            try warnings.append(try std.fmt.allocPrint(arena, "could not stat {s} (cached data kept)", .{path}));
            try appendCachedFallback(&current, &previous, path);
            continue;
        };
        const size: u64 = @intCast(st.size);
        const mtime_ms: i64 = st.mtime.toMilliseconds();
        if (previous.files.get(path)) |cached| {
            if (cached.size == size and cached.mtime_ms == mtime_ms) {
                try current.append(cached);
                continue;
            }
        }
        dirty = true;
        const data = std.Io.Dir.readFileAlloc(.cwd(), io, path, arena, .limited(1024 * 1024 * 1024)) catch {
            try warnings.append(try std.fmt.allocPrint(arena, "could not read {s} (cached data kept)", .{path}));
            try appendCachedFallback(&current, &previous, path);
            continue;
        };
        const parsed = parseSessionBuffer(arena, data) catch {
            try warnings.append(try std.fmt.allocPrint(arena, "could not parse {s} (cached data kept)", .{path}));
            try appendCachedFallback(&current, &previous, path);
            continue;
        };
        try current.append(.{
            .path = path,
            .size = size,
            .mtime_ms = mtime_ms,
            .session_id = parsed.session_id,
            .cwd = parsed.cwd,
            .messages = parsed.messages,
        });
    }
    if (!dirty) {
        // A cached file that no longer exists must be evicted.
        var pit = previous.files.keyIterator();
        while (pit.next()) |p| {
            var found = false;
            for (file_paths.items) |path| {
                if (mem.eql(u8, p.*, path)) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                dirty = true;
                break;
            }
        }
    }

    // 3. Persist the refreshed cache.
    if (dirty) {
        saveCache(io, arena, cache_path, current.items) catch {};
    }

    // 4. Aggregate in sorted path order with cross-file dedupe.
    var agg = try aggregate(arena, bounds, current.items, home);
    for (0..5) |pi| {
        agg.periods[pi].insights = try computeInsights(arena, &agg.periods[pi].raw, agg.trend);
    }
    return buildUsageJson(arena, &agg, bounds, warnings.items);
}

// =============================================================================
// =============================================================================
// Main (one-shot: request in argv[1], one envelope on stdout, exit)
// =============================================================================

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-usage '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    if (mem.eql(u8, req.value.op, "collect")) {
        const agent_dir = mem.trim(u8, req.value.agent_dir orelse "", " \t\r\n");
        if (agent_dir.len == 0) respondExit(arena, io, false, "missing agent_dir");
        const bounds = req.value.bounds orelse respondExit(arena, io, false, "missing bounds");
        const result = runCollect(arena, io, init.environ_map, agent_dir, bounds) catch |err| respondExit(arena, io, false, @errorName(err));
        respondExit(arena, io, true, result);
    } else if (mem.eql(u8, req.value.op, "limits")) {
        // The fetch runs on the main thread; a hung network is bounded by the
        // glue's pi.exec timeout, which SIGTERMs this process.
        const result = buildLimitsJson(arena, io, init.environ_map, req.value.codex_access, req.value.codex_account_id, req.value.codex_email) catch |err| respondExit(arena, io, false, @errorName(err));
        respondExit(arena, io, true, result);
    } else {
        respondExit(arena, io, false, "unknown op");
    }
}
