// pi-lg: lazygit-in-the-terminal backend for the pi /lg command.
//
// The pi extension (extensions/lazygit.ts) sends one JSON request per line
// on stdin, we answer with one JSON response line on stdout. The extension
// owns the pi TUI lifecycle (stop before lazygit takes the terminal, start
// after it exits); this backend owns everything process-related: validation,
// repo detection, spawning lazygit attached to the real terminal, and
// reporting the exit status.
//
// Request line:  {"id":1,"op":"prepare","cwd":"/path"}
//                {"id":2,"op":"run","cwd":"/path"}
// Response line: {"id":1,"ok":true,"result":"<repo-root>"}   (prepare)
//                {"id":2,"ok":true,"result":"exited 0"}      (run)
//                {"id":N,"ok":false,"error":"..."}
//
// prepare runs before the TUI stops so common failures (lazygit missing, not
// a git repository) surface as a notification without blinking the screen.
// run opens /dev/tty (the controlling terminal) and spawns lazygit with
// stdin/stdout/stderr pointing at it, so lazygit renders full-screen over the
// stopped pi TUI exactly like it does over nvim. The extension restarts the
// TUI when run reports back.
//
// Unix-only by design: /dev/tty does not exist on Windows, so there is no
// controlling terminal to hand lazygit there. pi itself already treats
// suspend-to-background and external editors as Unix features, and this
// extension follows the same line. Windows support (CONIN$/CONOUT$ handoff)
// is out of scope.

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
const GitResult = common.GitResult;
const runCmd = common.runCmd;
const gitRoot = common.gitRoot;

const MAX_LINE = 4 * 1024 * 1024; // hard cap on a single request line

const Request = struct {
    id: i64,
    op: []const u8,
    cwd: ?[]const u8 = null,
};

const PrepareOutcome = struct {
    ok: bool = false,
    repo: []const u8 = "",
    err: []const u8 = "",
};

const RunOutcome = struct {
    ok: bool = false,
    text: []const u8 = "",
    err: []const u8 = "",
};

// ---------------------------------------------------------------------------
// Process helpers

fn spawnErrText(err: anyerror) []const u8 {
    return switch (err) {
        error.FileNotFound => "lazygit not found in PATH (install with: brew install lazygit)",
        error.AccessDenied => "lazygit is not executable",
        else => @errorName(err),
    };
}

// ---------------------------------------------------------------------------
// prepare

fn prepare(arena: Allocator, io: std.Io, cwd: []const u8) !PrepareOutcome {
    // Resolved via PATH; also proves the binary actually runs.
    const check = try runCmd(arena, io, &.{ "lazygit", "--version" }, 4096);
    if (!check.ok) {
        return .{ .err = "lazygit not found in PATH (install with: brew install lazygit)" };
    }
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };
    return .{ .ok = true, .repo = root };
}

// ---------------------------------------------------------------------------
// run

fn termText(arena: Allocator, term: std.process.Child.Term) ![]const u8 {
    return switch (term) {
        .exited => |code| std.fmt.allocPrint(arena, "exited {d}", .{code}),
        .signal => |sig| std.fmt.allocPrint(arena, "signal {d}", .{@intFromEnum(sig)}),
        .stopped => arena.dupe(u8, "stopped"),
        .unknown => |code| std.fmt.allocPrint(arena, "unknown {d}", .{code}),
    };
}

// Spawns lazygit attached to the real terminal. binary is an optional
// explicit path (self-check uses a fake script); null resolves "lazygit"
// from PATH like the real flow.
fn runLazygit(arena: Allocator, io: std.Io, cwd: []const u8, binary: ?[]const u8) !RunOutcome {
    // /dev/tty is the controlling terminal, the same one pi's TUI renders
    // on. The backend's own stdin/stdout are pipes to the glue, so lazygit
    // cannot inherit them; handing it the tty directly is the handoff.
    const tty = std.Io.Dir.openFileAbsolute(io, "/dev/tty", .{ .mode = .read_write }) catch
        return .{ .err = "cannot open controlling terminal /dev/tty" };
    defer tty.close(io);

    const argv: []const []const u8 = if (binary) |b| &[_][]const u8{b} else &[_][]const u8{"lazygit"};
    var child = std.process.spawn(io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .stdin = .{ .file = tty },
        .stdout = .{ .file = tty },
        .stderr = .{ .file = tty },
    }) catch |err| return .{ .err = spawnErrText(err) };

    const term = child.wait(io) catch return .{ .err = "waiting for lazygit failed" };
    return .{ .ok = true, .text = try termText(arena, term) };
}

// ---------------------------------------------------------------------------
// self-check

fn selfCheck(gpa: Allocator, io: std.Io) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const fail = struct {
        fn f(cond: bool, msg: []const u8) void {
            if (!cond) {
                std.debug.print("FAIL: {s}\n", .{msg});
                std.process.exit(1);
            }
        }
    }.f;

    const check = try runCmd(arena, io, &.{ "lazygit", "--version" }, 4096);
    fail(check.ok, "lazygit must be installed (brew install lazygit)");

    const dir = try std.fmt.allocPrint(arena, "/tmp/pi-lg-selfcheck-{d}", .{nowMs()});
    const cwd_dir = std.Io.Dir.cwd();
    cwd_dir.deleteTree(io, dir) catch {};
    cwd_dir.createDirPath(io, dir) catch |err| {
        std.debug.print("FAIL: mkdir {s}: {s}\n", .{ dir, @errorName(err) });
        std.process.exit(1);
    };
    defer cwd_dir.deleteTree(io, dir) catch {};

    const init = try runCmd(arena, io, &.{ "git", "init", "-q", dir }, 4096);
    fail(init.ok, "git init in temp repo");

    const prep_ok = try prepare(arena, io, dir);
    fail(prep_ok.ok, "prepare succeeds in a git repo");
    fail(mem.eql(u8, std.fs.path.basename(prep_ok.repo), std.fs.path.basename(dir)), "prepare reports the repo root");

    const non_repo = try std.fmt.allocPrint(arena, "{s}/nope", .{dir});
    const prep_bad = try prepare(arena, io, non_repo);
    fail(!prep_bad.ok, "prepare fails outside a git repo");

    // Exercise the spawn + wait + report path with a fake lazygit that
    // exits 42. No real lazygit is spawned in self-check. Skipped when the
    // process has no controlling terminal (CI, detached shells), because
    // /dev/tty is the whole point of the run op.
    const tty = std.Io.Dir.openFileAbsolute(io, "/dev/tty", .{ .mode = .read_write }) catch {
        std.debug.print("SKIP: no controlling terminal, spawn path not exercised\n", .{});
        std.debug.print("PASS: pi-lg self-check ok\n", .{});
        return;
    };
    tty.close(io);

    const fake_dir = try std.fmt.allocPrint(arena, "{s}/fakebin", .{dir});
    cwd_dir.createDirPath(io, fake_dir) catch |err| {
        std.debug.print("FAIL: mkdir {s}: {s}\n", .{ fake_dir, @errorName(err) });
        std.process.exit(1);
    };
    const script_path = try std.fmt.allocPrint(arena, "{s}/lazygit", .{fake_dir});
    const script = std.Io.Dir.createFileAbsolute(io, script_path, .{}) catch |err| {
        std.debug.print("FAIL: create {s}: {s}\n", .{ script_path, @errorName(err) });
        std.process.exit(1);
    };
    try writeAllIo(io, script, "#!/bin/sh\nexit 42\n");
    script.close(io);
    cwd_dir.setFilePermissions(io, script_path, .executable_file, .{}) catch |err| {
        std.debug.print("FAIL: chmod {s}: {s}\n", .{ script_path, @errorName(err) });
        std.process.exit(1);
    };

    const run = try runLazygit(arena, io, dir, script_path);
    fail(run.ok, "run spawns the fake lazygit");
    fail(mem.eql(u8, run.text, "exited 42"), "run reports the exit code");

    std.debug.print("PASS: pi-lg self-check ok\n", .{});
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

    while (true) {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();

        const line = readLine(posix.STDIN_FILENO, &stdin_buf, MAX_LINE, arena, null) catch break orelse break;
        if (line.len == 0) continue;

        const req = json.parseFromSlice(Request, arena, line, .{ .ignore_unknown_fields = true }) catch |err| {
            respond(arena, io, 0, false, @errorName(err)) catch {};
            continue;
        };
        const r = req.value;
        const id = r.id;

        if (mem.eql(u8, r.op, "prepare")) {
            const cwd = r.cwd orelse {
                respond(arena, io, id, false, "missing cwd") catch {};
                continue;
            };
            const outcome = prepare(arena, io, cwd) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (!outcome.ok) {
                respond(arena, io, id, false, outcome.err) catch {};
                continue;
            }
            respond(arena, io, id, true, outcome.repo) catch {};
        } else if (mem.eql(u8, r.op, "run")) {
            const cwd = r.cwd orelse {
                respond(arena, io, id, false, "missing cwd") catch {};
                continue;
            };
            const outcome = runLazygit(arena, io, cwd, null) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (!outcome.ok) {
                respond(arena, io, id, false, outcome.err) catch {};
                continue;
            }
            respond(arena, io, id, true, outcome.text) catch {};
        } else {
            respond(arena, io, id, false, "unknown op") catch {};
        }
    }
}
