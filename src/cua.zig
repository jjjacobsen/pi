// pi-cua: desktop computer-use backend for the pi coding agent.
//
// Spawns `cua-driver call <tool> <json-args>` once per request. The
// cua-driver CLI proxies to the CuaDriver daemon (CuaDriver.app on macOS),
// which owns the OS permissions (Accessibility + Screen Recording) and
// drives real windows without moving the system cursor. Everything about
// the child lifecycle, deadlines, screenshot files, and result shaping
// lives here; the TS glue only registers tool schemas.
//
// Request line:  {"id":1,"op":"call","tool":"get_window_state","params":"{\"pid\":123}","bin":"...","shots_dir":"...","timeout_ms":120000}
// Response line: {"id":1,"ok":true,"result":"..."}  or  {"id":1,"ok":false,"error":"..."}
//
// `bin`, `shots_dir`, and `timeout_ms` override the defaults and are used
// only by the self-check (a fake cua-driver script); the glue sends only
// op/tool/params.
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
const readLine = common.readLine;
const writeAllIo = common.writeAllIo;
const respond = common.respond;

const MAX_LINE = 64 * 1024 * 1024; // hard cap on a child stdout line
const MAX_RESULT = 256 * 1024; // cap on the result text returned to the glue
const CALL_TIMEOUT_MS: i64 = 120_000; // default per-call bound (AX walks on Electron apps are slow)
const SCREENSHOT_KEEP = 25; // newest screenshot files kept in the shots dir
const MAX_STDERR = 16 * 1024; // cap on captured child stderr

var g_terminate = std.atomic.Value(bool).init(false);

const Request = struct {
    id: i64,
    op: []const u8, // "call"
    tool: []const u8 = "", // cua-driver MCP tool name, e.g. "get_window_state"
    params: []const u8 = "{}", // JSON string containing the raw arguments object
    bin: ?[]const u8 = null, // cua-driver binary override, self-check only
    shots_dir: ?[]const u8 = null, // screenshot directory override, self-check only
    timeout_ms: ?i64 = null, // deadline override, self-check only
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

fn shotsDirPath(arena: Allocator, environ: *std.process.Environ.Map, override: ?[]const u8) ![]const u8 {
    if (override) |o| return o;
    const home = environ.get("HOME") orelse return error.NoHome;
    return std.fmt.allocPrint(arena, "{s}/.pi/agent/cua-screenshots", .{home});
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
fn newShotPath(io: std.Io, arena: Allocator, environ: *std.process.Environ.Map, tool: []const u8, override: ?[]const u8) ![]const u8 {
    const dir = try shotsDirPath(arena, environ, override);
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
fn runCall(gpa: Allocator, io: std.Io, arena: Allocator, environ: *std.process.Environ.Map, req: *const Request) !CallResult {
    const bin = req.bin orelse "cua-driver";
    const timeout_ms = req.timeout_ms orelse CALL_TIMEOUT_MS;

    var argv_list = std.ArrayList([]const u8).empty;
    try argv_list.append(arena, bin);
    try argv_list.append(arena, "call");
    var shot_path: ?[]const u8 = null;
    if (isImageTool(req.tool)) {
        shot_path = newShotPath(io, arena, environ, req.tool, req.shots_dir) catch |err| {
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

// ---------------------------------------------------------------------------
// Self-check: exercises the full dispatch against a fake cua-driver script,
// so `mise check` passes without a daemon or OS permissions. The fake
// records its argv to a log, writes screenshot files, and serves canned
// responses (including a stderr failure, an in-band error payload, and a
// slow call for the deadline path).

fn selfCheck(gpa: Allocator, io: std.Io, environ: *std.process.Environ.Map) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const check = common.expect;
    const dir = try common.selfCheckDir(arena, io, "cua");
    defer std.Io.Dir.cwd().deleteTree(io, dir) catch {};
    const shots = try std.fmt.allocPrint(arena, "{s}/shots", .{dir});
    const log_path = try std.fmt.allocPrint(arena, "{s}/args.log", .{dir});
    const script_path = try std.fmt.allocPrint(arena, "{s}/cua-driver", .{dir});
    const script = std.Io.Dir.createFileAbsolute(io, script_path, .{}) catch |err| {
        std.debug.print("FAIL: create fake driver: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    const sh = try std.fmt.allocPrint(arena,
        \\#!/bin/sh
        \\# fake cua-driver for the pi-cua self-check
        \\log="{s}"
        \\shift  # skip the "call" subcommand
        \\out=""
        \\if [ "$1" = "--screenshot-out-file" ]; then
        \\  out="$2"
        \\  shift 2
        \\fi
        \\tool="$1"
        \\shift
        \\echo "tool=$tool params=$1 out=$out" >> "$log"
        \\case "$tool" in
        \\  get_window_state)
        \\    printf 'fake-png' > "$out"
        \\    echo '{{"pid":86748,"window_id":51958,"element_count":3,"snapshot_id":"s0000000e","window_bounds":{{"x":0.0,"y":33.0,"width":1512.0,"height":949.0}},"screenshot_width":1568,"screenshot_height":984,"screenshot_scale":2.0,"tree_markdown":"Window: Ghostty\\n  - [1] Fake Button [actions=[press]]\\n  - [2] Fake Selected\\nSecond Line [actions=[press]]","elements":[{{"depth":1,"element_index":1,"element_token":"s0000000e:1","frame":{{"x":0.0,"y":0.0,"w":100.0,"h":20.0}},"label":"Fake Button","role":"AXButton","selected":false}},{{"depth":1,"element_index":2,"element_token":"s0000000e:2","frame":{{"x":0.0,"y":0.0,"w":100.0,"h":20.0}},"label":"Fake Selected","role":"AXButton","selected":true}}],"background_input":{{"routes":[{{"route":"accessibility","status":"available","reason":"ok"}},{{"route":"window_pointer","status":"refused","reason":"off_space_or_ax_unresolved"}}]}},"escalation":{{"recommended":"foreground"}}}}'
        \\    ;;
        \\  zoom)
        \\    printf 'fake-jpg' > "$out"
        \\    echo '{{"format":"jpeg","width":420,"height":280,"mime_type":"image/jpeg"}}'
        \\    ;;
        \\  list_apps)
        \\    echo '{{"apps":[{{"name":"Finder","pid":671,"running":true}}]}}'
        \\    ;;
        \\  fail_me)
        \\    echo "boom: simulated failure" >&2
        \\    exit 1
        \\    ;;
        \\  inband_error)
        \\    echo '{{"code":"window_id_not_found","window_id":999,"suggestion":"call list_windows for current window_ids"}}'
        \\    ;;
        \\  slow)
        \\    sleep 2
        \\    echo '{{"done":true}}'
        \\    ;;
        \\  *)
        \\    echo '{{"ok":true}}'
        \\    ;;
        \\esac
        \\
    , .{log_path});
    try writeAllIo(io, script, sh);
    script.close(io);
    std.Io.Dir.cwd().setFilePermissions(io, script_path, .executable_file, .{}) catch |err| {
        std.debug.print("FAIL: chmod fake driver: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };

    // Passthrough tool: the raw JSON comes back.
    var res = try runCall(gpa, io, arena, environ, &.{ .id = 1, .op = "call", .tool = "list_apps", .params = "{}", .bin = script_path, .shots_dir = shots });
    check(res.ok, "list_apps call succeeds");
    check(mem.indexOf(u8, res.text, "Finder") != null, "list_apps result carries the JSON");

    // get_window_state: tree extracted, elements dropped, path returned,
    // screenshot written to disk.
    res = try runCall(gpa, io, arena, environ, &.{ .id = 2, .op = "call", .tool = "get_window_state", .params = "{\"pid\":86748,\"window_id\":51958}", .bin = script_path, .shots_dir = shots });
    check(res.ok, "get_window_state call succeeds");
    check(mem.indexOf(u8, res.text, "Fake Button") != null, "tree markdown is extracted");
    check(mem.indexOf(u8, res.text, "- [1]") != null, "element tags are preserved");
    check(mem.indexOf(u8, res.text, "snapshot_id: s0000000e") != null, "snapshot id is surfaced");
    check(mem.indexOf(u8, res.text, "tok=s0000000e:1") != null, "element tokens are injected into tree rows");
    check(mem.indexOf(u8, res.text, "tok=s0000000e:2 [selected]") != null, "selected state is injected into tree rows");
    check(mem.indexOf(u8, res.text, "elements: 3") != null, "element count is reported");
    check(mem.indexOf(u8, res.text, "bounds: x=0 y=33 w=1512 h=949") != null, "window bounds are reported");
    check(mem.indexOf(u8, res.text, "screenshot: ") != null, "screenshot path is reported");
    check(mem.indexOf(u8, res.text, "window_pointer=refused (off_space_or_ax_unresolved)") != null, "background routes are summarized");
    check(mem.indexOf(u8, res.text, "escalation: recommended foreground") != null, "escalation recommendation is kept");

    // The screenshot file exists and holds the fake PNG bytes.
    const shots_dir = std.Io.Dir.cwd().openDir(io, shots, .{ .iterate = true }) catch |err| {
        std.debug.print("FAIL: open shots dir: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    defer shots_dir.close(io);
    var shot_name: ?[]const u8 = null;
    var it = shots_dir.iterate();
    while (it.next(io) catch null) |entry| {
        if (entry.kind == .file) shot_name = arena.dupe(u8, entry.name) catch null;
    }
    check(shot_name != null, "screenshot file was written");
    if (shot_name) |name| {
        const data = shots_dir.readFileAlloc(io, name, arena, .limited(1024)) catch |err| {
            std.debug.print("FAIL: read screenshot: {s}\n", .{@errorName(err)});
            std.process.exit(1);
        };
        check(mem.eql(u8, data, "fake-png"), "screenshot file holds the image bytes");
    }

    // zoom: image tool, path prefix + raw metadata JSON.
    res = try runCall(gpa, io, arena, environ, &.{ .id = 3, .op = "call", .tool = "zoom", .params = "{\"pid\":86748,\"window_id\":51958,\"x1\":100,\"y1\":100,\"x2\":400,\"y2\":300}", .bin = script_path, .shots_dir = shots });
    check(res.ok, "zoom call succeeds");
    check(mem.indexOf(u8, res.text, "screenshot: ") != null, "zoom result carries the screenshot path");
    check(mem.indexOf(u8, res.text, "\"width\":420") != null, "zoom metadata passes through");

    // The args log proves the CLI invocation shape: --screenshot-out-file
    // before the tool name, and no out-file for plain tools.
    const log = std.Io.Dir.readFileAlloc(.cwd(), io, log_path, arena, .limited(64 * 1024)) catch |err| {
        std.debug.print("FAIL: read args log: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };
    check(mem.indexOf(u8, log, "tool=get_window_state params={\"pid\":86748,\"window_id\":51958} out=") != null, "get_window_state got --screenshot-out-file");
    check(mem.indexOf(u8, log, "tool=list_apps params={} out=") != null, "plain tools get no out-file");

    // Stderr failure surfaces as the error message.
    res = try runCall(gpa, io, arena, environ, &.{ .id = 4, .op = "call", .tool = "fail_me", .params = "{}", .bin = script_path, .shots_dir = shots });
    check(!res.ok, "stderr failure is a failed call");
    check(mem.indexOf(u8, res.text, "boom: simulated failure") != null, "stderr text is the error message");

    // In-band error payloads (window_id_not_found, invalid_arguments) pass
    // through as results: the model must see and recover from them.
    res = try runCall(gpa, io, arena, environ, &.{ .id = 5, .op = "call", .tool = "inband_error", .params = "{}", .bin = script_path, .shots_dir = shots });
    check(res.ok, "in-band error payload passes through as a result");
    check(mem.indexOf(u8, res.text, "window_id_not_found") != null, "the payload code is visible to the model");

    // Deadline: a slow call past timeout_ms is cut off.
    res = try runCall(gpa, io, arena, environ, &.{ .id = 6, .op = "call", .tool = "slow", .params = "{}", .bin = script_path, .shots_dir = shots, .timeout_ms = 300 });
    check(!res.ok, "slow call times out");
    check(mem.eql(u8, res.text, "Timeout"), "timeout error is reported");

    // Missing binary surfaces a spawn failure, not a hang.
    res = try runCall(gpa, io, arena, environ, &.{ .id = 7, .op = "call", .tool = "list_apps", .params = "{}", .bin = "/nonexistent/cua-driver", .shots_dir = shots });
    check(!res.ok, "missing binary is a failed call");
    check(mem.indexOf(u8, res.text, "failed to spawn") != null, "spawn failure is reported");

    std.debug.print("PASS: cua-driver call dispatch works\n", .{});
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector; // []const [*:0]const u8 on posix
    if (argv.len > 1 and mem.eql(u8, std.mem.sliceTo(argv[1], 0), "--self-check")) {
        try selfCheck(gpa, io, init.environ_map);
        return;
    }

    const S = struct {
        fn handler(_: posix.SIG) callconv(.c) void {
            g_terminate.store(true, .seq_cst);
        }
    };
    const sa = posix.Sigaction{
        .handler = .{ .handler = S.handler },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.TERM, &sa, null);
    posix.sigaction(posix.SIG.INT, &sa, null);

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var stdin_buf = List.init(gpa);
    defer stdin_buf.deinit();

    while (!g_terminate.load(.seq_cst)) {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();

        const line = readLine(posix.STDIN_FILENO, &stdin_buf, MAX_LINE, arena, null) catch |err| {
            std.debug.print("pi-cua: {s}\n", .{@errorName(err)});
            break;
        } orelse break;
        if (line.len == 0) continue;

        const req = json.parseFromSlice(Request, arena, line, .{ .ignore_unknown_fields = true }) catch |err| {
            respond(arena, io, 0, false, @errorName(err)) catch {};
            continue;
        };

        const res = runCall(gpa, io, arena, init.environ_map, &req.value) catch |err| CallResult{
            .ok = false,
            .text = @errorName(err),
        };
        respond(arena, io, req.value.id, res.ok, res.text) catch {};
    }
}
