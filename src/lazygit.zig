// pi-lg: lazygit-in-the-terminal backend for the pi /lg command.
//
// One-shot by design: the pi extension (extensions/lazygit.ts) spawns this
// binary once per call with the request as a single JSON argv element via
// pi.exec, we answer with one JSON envelope on stdout and exit. The
// extension owns the pi TUI lifecycle (stop before lazygit takes the
// terminal, start after it exits); this backend owns everything
// process-related: validation, repo detection, spawning lazygit attached to
// the real terminal, and reporting the exit status.
//
// Request:  {"op":"prepare","cwd":"/path"}
//           {"op":"run","cwd":"/path"}            (one JSON argv element)
// Response: {"ok":true,"result":"<repo-root>"}    (prepare)
//           {"ok":true,"result":"exited 0"}       (run)
//           {"ok":false,"error":"..."}            (stdout, exit 0/1)
//
// prepare runs before the TUI stops so common failures (lazygit missing, not
// a git repository) surface as a notification without blinking the screen.
// run opens /dev/tty (the controlling terminal) and spawns lazygit with
// stdin/stdout/stderr pointing at it, so lazygit renders full-screen over the
// stopped pi TUI exactly like it does over nvim. The extension restarts the
// TUI when run reports back.
//
// Because run spawns a long-lived child (lazygit is open until the user
// quits), we install a SIGTERM/SIGINT handler that forwards the signal to
// the child: when pi aborts or tears down the session mid-lazygit, killing
// the child returns the terminal to a sane state instead of leaving lazygit
// orphaned on the tty. cwd's resolved against git during prepare.
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
const respondExit = common.respondExit;
const respondOutcomeExit = common.respondOutcomeExit;
const failOutcome = common.failOutcome;
const runCmd = common.runCmd;
const gitRoot = common.gitRoot;

const Request = struct {
    op: []const u8,
    cwd: ?[]const u8 = null,
};

// The pid of the running lazygit child (0 when none). Read by the signal
// handler so an abort/teardown of pi-lg can SIGTERM lazygit and return the
// terminal cleanly instead of orphaning it.
var g_child_pid: std.atomic.Value(posix.pid_t) = .init(0);

// ---------------------------------------------------------------------------
// Signal handler

const S = struct {
    fn handler(_: posix.SIG) callconv(.c) void {
        const pid = g_child_pid.load(.seq_cst);
        if (pid > 0) posix.kill(pid, posix.SIG.TERM) catch {};
    }
};

fn installSignalHandler() void {
    const sa = posix.Sigaction{
        .handler = .{ .handler = S.handler },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(posix.SIG.TERM, &sa, null);
    posix.sigaction(posix.SIG.INT, &sa, null);
}

// ---------------------------------------------------------------------------
// prepare

fn prepare(arena: Allocator, io: std.Io, cwd: []const u8) !common.Outcome {
    // Resolved via PATH; also proves the binary actually runs.
    const check = try runCmd(arena, io, &.{ "lazygit", "--version" }, 4096);
    if (!check.ok) {
        return failOutcome(arena, "lazygit not found in PATH (install with: brew install lazygit)", .{});
    }
    const root = (try gitRoot(arena, io, cwd)) orelse
        return failOutcome(arena, "not a git repository", .{});
    return .{ .ok = true, .text = root };
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

fn spawnErrText(err: anyerror) []const u8 {
    return switch (err) {
        error.FileNotFound => "lazygit not found in PATH (install with: brew install lazygit)",
        error.AccessDenied => "lazygit is not executable",
        else => @errorName(err),
    };
}

// Spawns lazygit attached to the real terminal, resolved from PATH.
fn runLazygit(arena: Allocator, io: std.Io, cwd: []const u8) !common.Outcome {
    // /dev/tty is the controlling terminal, the same one pi's TUI renders
    // on. The backend's own stdin/stdout are pipes to the glue, so lazygit
    // cannot inherit them; handing it the tty directly is the handoff.
    const tty = std.Io.Dir.openFileAbsolute(io, "/dev/tty", .{ .mode = .read_write }) catch
        return failOutcome(arena, "cannot open controlling terminal /dev/tty", .{});
    defer tty.close(io);

    const argv: []const []const u8 = &[_][]const u8{"lazygit"};
    var child = std.process.spawn(io, .{
        .argv = argv,
        .cwd = .{ .path = cwd },
        .stdin = .{ .file = tty },
        .stdout = .{ .file = tty },
        .stderr = .{ .file = tty },
    }) catch |err| return failOutcome(arena, "{s}", .{spawnErrText(err)});

    // Publish the pid so the signal handler can forward an abort to lazygit.
    if (child.id) |pid| g_child_pid.store(pid, .seq_cst);
    defer g_child_pid.store(0, .seq_cst);

    const term = child.wait(io) catch |err| return failOutcome(arena, "waiting for lazygit failed ({s})", .{@errorName(err)});
    return .{ .ok = true, .text = try termText(arena, term) };
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-lg '<request json>'\n", .{});
        std.process.exit(2);
    }

    installSignalHandler();

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const r = req.value;
    const cwd = r.cwd orelse respondExit(arena, io, false, "missing cwd");

    const outcome = if (mem.eql(u8, r.op, "prepare"))
        prepare(arena, io, cwd) catch |err| respondExit(arena, io, false, @errorName(err))
    else if (mem.eql(u8, r.op, "run"))
        runLazygit(arena, io, cwd) catch |err| respondExit(arena, io, false, @errorName(err))
    else
        respondExit(arena, io, false, "unknown op");

    respondOutcomeExit(arena, io, outcome);
}
