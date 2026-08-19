// pi-cua: desktop computer-use backend for the pi coding agent.
//
// Spawns `cua-driver call <tool> <json-args>` once per request. The
// cua-driver CLI proxies to the CuaDriver daemon (CuaDriver.app on macOS),
// which owns the OS permissions (Accessibility + Screen Recording) and
// drives real windows without moving the system cursor. Everything about
// the child lifecycle, deadlines, screenshot files, and result shaping
// lives here; the TS glue only registers tool schemas.
//
// One request per process: the request arrives as one JSON argv element
// (via pi.exec), the binary prints one JSON envelope to stdout and exits.
// Request:  {"op":"call","agent_dir":"..","tool":"get_window_state","params":"{\"pid\":123}"}   params is a JSON string
// Response: {"ok":true,"result":"..."}  or  {"ok":false,"error":"..."}
// Exit:     0 on ok, 1 on protocol error, other on crash (trace on stderr)
//
// Result rules (learned from the real CLI):
// - stdout carries the tool result as one JSON line. Non-empty stdout is
//   the result, even when the payload is an in-band error such as
//   {"code":"window_id_not_found",...}: those are normal operational
//   outcomes the model must see and recover from, so they pass through.
// - An empty stdout means the call failed: the error text is on stderr
//   (e.g. "Permission denied: tool 'x' has no reviewed risk
//   classification"), or the exit status when stderr is also empty.
// - Exit codes are unreliable (invalid args exit 0), so they are never
//   used to judge success.
// - Image tools (get_window_state, get_desktop_state, zoom) embed base64
//   in the response unless --screenshot-out-file is passed. We always pass
//   it, and the response does NOT echo the path back, so we track it
//   ourselves: get_window_state gets it appended by the tree extraction,
//   the other two get a "screenshot: <path>" prefix line.
// - The child's stdin must not be a pipe: cua-driver call reads stdin when
//   it is piped (blocking forever on our open pipe). .ignore (a /dev/null
//   open) is what the CLI already tolerates.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const nowMs = common.nowMs;
const readLine = common.readLine; // drains the cua-driver child's stdout line
const respondExit = common.respondExit;

const MAX_LINE = 64 * 1024 * 1024; // hard cap on a child stdout line
const MAX_RESULT = 256 * 1024; // cap on the result text returned to the glue
const CALL_TIMEOUT_MS: i64 = 120_000; // default per-call bound (AX walks on Electron apps are slow)
const SCREENSHOT_KEEP = 25; // newest screenshot files kept in the shots dir
const MAX_STDERR = 16 * 1024; // cap on captured child stderr

const Request = struct {
    op: []const u8, // "call"
    agent_dir: ?[]const u8 = null, // glue-resolved agent dir; screenshots live under {agent_dir}/cua-screenshots
    tool: []const u8 = "", // cua-driver MCP tool name, e.g. "get_window_state"
    params: []const u8 = "{}", // JSON string containing the raw arguments object
};

const CallResult = struct {
    ok: bool,
    text: []const u8,
};

// Truncates text over MAX_RESULT to its head and tail with an explicit
// marker, so the model still sees the start and end of a huge response.
fn capResult(arena: Allocator, text: []const u8) ![]const u8 {
    if (text.len <= MAX_RESULT) return text;
    const head_len = MAX_RESULT * 3 / 4;
    const tail_len = MAX_RESULT - head_len;
    return std.fmt.allocPrint(arena, "{s}\n\n… [{d} bytes truncated] …\n\n{s}", .{ text[0..head_len], text.len - MAX_RESULT, text[text.len - tail_len ..] });
}

fn isImageTool(tool: []const u8) bool {
    return mem.eql(u8, tool, "get_window_state") or mem.eql(u8, tool, "get_desktop_state") or mem.eql(u8, tool, "zoom");
}

fn shotExt(tool: []const u8) []const u8 {
    return if (mem.eql(u8, tool, "zoom")) "jpg" else "png";
}

fn shotsDirPath(arena: Allocator, agent_dir: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "{s}/cua-screenshots", .{agent_dir});
}

fn lessThanNameDesc(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.order(u8, a, b) == .gt;
}

// Deletes the oldest screenshot files so the shots dir cannot grow without
// bound. Names are shot-<millis>.<ext>, so lexicographic order is time
// order; keep the newest SCREENSHOT_KEEP.
fn pruneShots(io: std.Io, arena: Allocator, dir_path: []const u8) void {
    const dir = std.Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(io);
    var names = std.ArrayList([]const u8).empty;
    var it = dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (entry.kind != .file) continue;
        names.append(arena, arena.dupe(u8, entry.name) catch continue) catch continue;
    }
    std.mem.sort([]const u8, names.items, {}, lessThanNameDesc);
    if (names.items.len > SCREENSHOT_KEEP) {
        for (names.items[SCREENSHOT_KEEP..]) |name| dir.deleteFile(io, name) catch {};
    }
}

// Returns a fresh screenshot path in the shots dir (created on demand,
// pruned to the newest SCREENSHOT_KEEP files).
fn newShotPath(io: std.Io, arena: Allocator, agent_dir: []const u8, tool: []const u8) ![]const u8 {
    const dir = try shotsDirPath(arena, agent_dir);
    std.Io.Dir.cwd().createDirPath(io, dir) catch |err| return err;
    pruneShots(io, arena, dir);
    return std.fmt.allocPrint(arena, "{s}/shot-{d}.{s}", .{ dir, nowMs(), shotExt(tool) });
}

// Background drain of the child's stderr into a capped shared buffer. The
// child's stderr is small (single-line errors), but a pipe that nobody
// drains would deadlock a verbose child, and the error text is the message
// we surface when stdout is empty.
const StderrState = struct {
    mutex: std.Io.Mutex = .init,
    buf: List, // page-allocator managed list, capped at MAX_STDERR
};

fn drainStderr(io: std.Io, fd: posix.fd_t, state: *StderrState) void {
    var chunk: [8192]u8 = undefined;
    while (true) {
        const n = posix.read(fd, &chunk) catch break;
        if (n == 0) break;
        state.mutex.lockUncancelable(io);
        defer state.mutex.unlock(io);
        if (state.buf.items.len < MAX_STDERR) {
            const room = @min(n, MAX_STDERR - state.buf.items.len);
            state.buf.appendSlice(chunk[0..room]) catch {};
        }
    }
}

// Appends an integer or float JSON number to buf.
fn printNumber(buf: *List, v: json.Value) !void {
    switch (v) {
        .integer => |i| try buf.print("{d}", .{i}),
        .float => |f| try buf.print("{d}", .{f}),
        else => {},
    }
}

// get_window_state returns the AX tree twice: a model-facing tree_markdown
// (rows tagged with [element_index N]) and a structuredContent.elements
// array with up to 2000 entries (the same rows, JSON-shaped, each carrying
// an element_token and an optional selected flag). The elements array is
// redundant bloat for the model, so it is dropped; but its tokens and
// selected flags are injected into the markdown rows ("tok=...") so every
// tree row is directly clickable via element_token, and the snapshot_id is
// surfaced so element_index + snapshot_id clicks work too. The result also
// keeps the fields action selection needs: window bounds, the screenshot
// path (we chose it), element count, degraded reason, background-input
// route statuses, and the escalation recommendation. A payload without
// tree_markdown (e.g. an in-band error such as window_id_not_found) passes
// through raw.
fn extractWindowState(arena: Allocator, out: []const u8, shot_path: []const u8) ![]const u8 {
    const parsed = json.parseFromSlice(json.Value, arena, out, .{}) catch {
        return capResult(arena, out);
    };
    const root = parsed.value;
    if (root != .object) return capResult(arena, out);
    const obj = root.object;
    if (obj.get("tree_markdown") == null) return capResult(arena, out);

    var buf = List.init(arena);
    try buf.appendSlice("pid: ");
    if (obj.get("pid")) |v| try printNumber(&buf, v) else try buf.appendSlice("?");
    try buf.appendSlice("  window_id: ");
    if (obj.get("window_id")) |v| try printNumber(&buf, v) else try buf.appendSlice("?");
    if (obj.get("snapshot_id")) |sid| {
        if (sid == .string and sid.string.len > 0) {
            try buf.appendSlice("  snapshot_id: ");
            try buf.appendSlice(sid.string);
        }
    }
    if (obj.get("element_count")) |v| {
        try buf.appendSlice("  elements: ");
        try printNumber(&buf, v);
    }
    if (obj.get("window_bounds")) |wb| {
        if (wb == .object) {
            const b = wb.object;
            if (b.get("x") != null or b.get("y") != null or b.get("width") != null or b.get("height") != null) {
                try buf.appendSlice("\nbounds: ");
                if (b.get("x")) |v| {
                    try buf.appendSlice("x=");
                    try printNumber(&buf, v);
                    try buf.appendSlice(" ");
                }
                if (b.get("y")) |v| {
                    try buf.appendSlice("y=");
                    try printNumber(&buf, v);
                    try buf.appendSlice(" ");
                }
                if (b.get("width")) |v| {
                    try buf.appendSlice("w=");
                    try printNumber(&buf, v);
                    try buf.appendSlice(" ");
                }
                if (b.get("height")) |v| {
                    try buf.appendSlice("h=");
                    try printNumber(&buf, v);
                }
            }
        }
    }
    try buf.appendSlice("\nscreenshot: ");
    try buf.appendSlice(shot_path);
    if (obj.get("screenshot_width")) |w| {
        try buf.appendSlice(" (");
        try printNumber(&buf, w);
        try buf.appendSlice("x");
        if (obj.get("screenshot_height")) |h| try printNumber(&buf, h);
        if (obj.get("screenshot_scale")) |s| {
            try buf.appendSlice(", scale ");
            try printNumber(&buf, s);
        }
        try buf.appendSlice(")");
    }
    if (obj.get("degraded_reason")) |v| {
        if (v == .string) {
            try buf.appendSlice("\ndegraded: ");
            try buf.appendSlice(v.string);
        }
    }
    if (obj.get("background_input")) |bi| {
        if (bi == .object) {
            if (bi.object.get("routes")) |routes| {
                if (routes == .array and routes.array.items.len > 0) {
                    try buf.appendSlice("\nbackground: ");
                    for (routes.array.items, 0..) |r, i| {
                        if (i > 0) try buf.appendSlice(", ");
                        if (r != .object) continue;
                        const ro = r.object;
                        if (ro.get("route")) |rn| {
                            if (rn == .string) {
                                try buf.appendSlice(rn.string);
                                try buf.appendSlice("=");
                            }
                        }
                        if (ro.get("status")) |st| {
                            if (st == .string) try buf.appendSlice(st.string);
                        }
                        if (ro.get("reason")) |re| {
                            if (re == .string and !mem.eql(u8, re.string, "ok")) {
                                try buf.appendSlice(" (");
                                try buf.appendSlice(re.string);
                                try buf.appendSlice(")");
                            }
                        }
                    }
                }
            }
        }
    }
    if (obj.get("escalation")) |esc| {
        if (esc == .object) {
            if (esc.object.get("recommended")) |rec| {
                if (rec == .string) {
                    try buf.appendSlice("\nescalation: recommended ");
                    try buf.appendSlice(rec.string);
                }
            }
        }
    }
    // Build element_index -> {token, selected} from the structured elements
    // array so tree rows can carry their clickable element_token.
    var elem_info = std.StringHashMap(ElemInfo).init(arena);
    defer elem_info.deinit();
    if (obj.get("elements")) |els| {
        if (els == .array) {
            for (els.array.items) |e| {
                if (e != .object) continue;
                const eo = e.object;
                const idx = eo.get("element_index") orelse continue;
                const tok = eo.get("element_token") orelse continue;
                if (idx != .integer or tok != .string) continue;
                const selected = if (eo.get("selected")) |s| (s == .bool and s.bool) else false;
                var key_buf: [32]u8 = undefined;
                const key = arena.dupe(u8, std.fmt.bufPrint(&key_buf, "{d}", .{idx.integer}) catch continue) catch continue;
                elem_info.put(key, .{ .token = tok.string, .selected = selected }) catch continue;
            }
        }
    }

    if (obj.get("tree_markdown")) |tm| {
        if (tm == .string and tm.string.len > 0) {
            try buf.appendSlice("\ntree:\n");
            var lines = std.mem.splitScalar(u8, tm.string, '\n');
            while (lines.next()) |line| {
                var i: usize = 0;
                while (i < line.len and line[i] == ' ') i += 1;
                // A row starts with "- [N] "; continuation lines (labels
                // spanning multiple lines) never start with "- [".
                if (i + 3 < line.len and line[i] == '-' and line[i + 1] == ' ' and line[i + 2] == '[') {
                    var j = i + 3;
                    const start = j;
                    while (j < line.len and line[j] >= '0' and line[j] <= '9') j += 1;
                    if (j > start and j < line.len and line[j] == ']') {
                        if (elem_info.get(line[start..j])) |info| {
                            try buf.appendSlice(line[0 .. j + 1]);
                            try buf.appendSlice(" tok=");
                            try buf.appendSlice(info.token);
                            if (info.selected) try buf.appendSlice(" [selected]");
                            try buf.appendSlice(line[j + 1 ..]);
                            try buf.appendSlice("\n");
                            continue;
                        }
                    }
                }
                try buf.appendSlice(line);
                try buf.appendSlice("\n");
            }
        } else {
            try buf.appendSlice("\ntree: (empty)");
        }
    }
    return capResult(arena, buf.items);
}

const ElemInfo = struct {
    token: []const u8,
    selected: bool,
};

// Runs one `cua-driver call` and shapes the outcome. Never fails with an
// error union on child trouble: spawn failures, timeouts, and empty-stdout
// failures become ok=false results with the message, so the glue always
// gets a clean response line.
fn runCall(gpa: Allocator, io: std.Io, arena: Allocator, agent_dir: []const u8, req: *const Request) !CallResult {
    const bin = "cua-driver";
    const timeout_ms = CALL_TIMEOUT_MS;

    var argv_list = std.ArrayList([]const u8).empty;
    try argv_list.append(arena, bin);
    try argv_list.append(arena, "call");
    var shot_path: ?[]const u8 = null;
    if (isImageTool(req.tool)) {
        shot_path = newShotPath(io, arena, agent_dir, req.tool) catch |err| {
            return .{ .ok = false, .text = try std.fmt.allocPrint(arena, "screenshot path: {s}", .{@errorName(err)}) };
        };
        try argv_list.append(arena, "--screenshot-out-file");
        try argv_list.append(arena, shot_path.?);
    }
    try argv_list.append(arena, req.tool);
    try argv_list.append(arena, req.params);

    // stdin .ignore: cua-driver call reads stdin when it is piped, which
    // would block forever on our open pipe (a /dev/null open is what the
    // CLI already tolerates; verified against the real binary).
    var child = std.process.spawn(io, .{
        .argv = argv_list.items,
        .stdin = .ignore,
        .stdout = .pipe,
        .stderr = .pipe,
    }) catch |err| {
        return .{ .ok = false, .text = try std.fmt.allocPrint(arena, "failed to spawn {s}: {s}", .{ bin, @errorName(err) }) };
    };
    // kill() blocks until the child is gone and closes its pipes; after a
    // successful wait() it is a documented no-op, so one defer covers every
    // path (timeout, OOM, read error) without leaking the child.
    defer child.kill(io);

    var stderr_state = StderrState{ .buf = List.init(std.heap.page_allocator) };
    defer stderr_state.buf.deinit();
    const stderr_thread = std.Thread.spawn(.{}, drainStderr, .{ io, child.stderr.?.handle, &stderr_state }) catch null;
    // The thread touches stderr_state, so it must be joined before this
    // function returns; kill()/wait() closing the stderr fd unblocks it.
    defer if (stderr_thread) |t| t.join();

    // Drain stdout to EOF (the result is one JSON line; a child that fills
    // the 64KB pipe buffer while we stopped reading would deadlock wait()).
    var line_buf = List.init(gpa);
    defer line_buf.deinit();
    var out = List.init(arena);
    const deadline = nowMs() + timeout_ms;
    const read_err: ?anyerror = blk: {
        while (true) {
            const line = readLine(child.stdout.?.handle, &line_buf, MAX_LINE, arena, deadline) catch |err| break :blk err;
            const l = line orelse break :blk null;
            try out.appendSlice(l);
            try out.appendSlice("\n");
        }
    };
    if (read_err) |err| {
        return .{ .ok = false, .text = @errorName(err) };
    }
    const term = child.wait(io) catch |err| {
        return .{ .ok = false, .text = @errorName(err) };
    };

    if (out.items.len > 0) {
        if (mem.eql(u8, req.tool, "get_window_state")) {
            return .{ .ok = true, .text = try extractWindowState(arena, out.items, shot_path orelse "") };
        }
        const capped = try capResult(arena, out.items);
        if (shot_path) |p| {
            // get_desktop_state and zoom do not echo the path back, so the
            // model needs it prepended to find the image.
            return .{ .ok = true, .text = try std.fmt.allocPrint(arena, "screenshot: {s}\n{s}", .{ p, capped }) };
        }
        return .{ .ok = true, .text = capped };
    }

    // Empty stdout: the call failed; surface the stderr text, else the exit.
    if (stderr_state.buf.items.len > 0) {
        return .{ .ok = false, .text = try std.fmt.allocPrint(arena, "{s}", .{mem.trim(u8, stderr_state.buf.items, " \t\r\n")}) };
    }
    return .{ .ok = false, .text = try std.fmt.allocPrint(arena, "{s} exited with {any}", .{ bin, term }) };
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-cua '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const res: CallResult = if (mem.eql(u8, req.value.op, "call")) blk: {
        // Screenshots live under the glue-resolved agent dir; fail loudly
        // when it is missing (no ~/.pi/agent fallback, per state rules).
        const agent_dir = req.value.agent_dir orelse break :blk .{ .ok = false, .text = "missing agent_dir" };
        if (agent_dir.len == 0) break :blk .{ .ok = false, .text = "missing agent_dir" };
        break :blk runCall(gpa, io, arena, agent_dir, &req.value) catch |err| .{ .ok = false, .text = @errorName(err) };
    } else .{ .ok = false, .text = "unknown op" };

    respondExit(arena, io, res.ok, res.text);
}
