// pi-wt: git worktree management for the pi /wt command.
//
// The pi extension (extensions/wt.ts) sends one JSON request per line on
// stdin, we answer with one JSON response line on stdout. The glue owns the
// pi session switch; this backend owns everything git-related.
//
// Request line:  {"id":1,"op":"create","cwd":"/path"}             (topic optional)
//                {"id":2,"op":"list","cwd":"/path"}
//                {"id":3,"op":"merge","cwd":"/path","topic":"x"}  (keep optional)
//                {"id":4,"op":"prune","cwd":"/path","topic":"x"}
// Response line: {"id":1,"ok":true,"result":"..."}
//                {"id":1,"ok":false,"error":"..."}
//
// create and merge return a JSON object string in result (parsed by the
// glue): create -> {"path":"...","branch":"wt/...","topic":"...","base":"..."}
// and merge -> {"merged":true,"up_to_date":false,"branch":"wt/...","text":"..."}
//
// create adds a worktree at <root>/.wt/<topic> on a new branch wt/<topic>
// from the current branch head (never carries uncommitted changes), and
// ensures the .wt/ dir is excluded from git status via .git/info/exclude
// (a local, never-committed file). The topic is the user's sanitized word or
// a generated adjective-noun name like "angry-aardvark".
//
// merge runs `git merge` in the caller's checkout: one rule, bring
// wt/<topic> into whatever branch the caller is on. Fast-forward when
// possible, merge commit otherwise, conflicts left for normal resolution.
//
// prune removes the worktree and deletes the branch, but never with --force
// or -D: a dirty worktree or an unmerged branch is left alone and reported.

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
const runGit = common.runCmd;
const gitRoot = common.gitRoot;

const MAX_LINE = 4 * 1024 * 1024; // hard cap on a single request line

const ADJECTIVES = [_][]const u8{
    "angry",   "brave",  "calm",     "clever",   "cosmic",  "crazy",   "cunning", "curious",
    "dashing", "dizzy",  "eager",    "electric", "fancy",   "fierce",  "fluffy",  "frosty",
    "fuzzy",   "gentle", "giant",    "gleeful",  "golden",  "grumpy",  "happy",   "hidden",
    "hungry",  "jolly",  "jumpy",    "lazy",     "lively",  "lonely",  "lucky",   "mighty",
    "misty",   "nimble", "noble",    "noisy",    "patient", "playful", "proud",   "purple",
    "quick",   "quiet",  "rapid",    "royal",    "shiny",   "silent",  "sleepy",  "sneaky",
    "speedy",  "spooky", "stealthy", "swift",    "tiny",    "tricky",  "vibrant", "wild",
    "witty",   "zesty",
};

const NOUNS = [_][]const u8{
    "aardvark", "alpaca",   "badger",    "banana",   "beetle", "bird",    "bison",     "bunny",
    "cactus",   "camel",    "catfish",   "cheetah",  "cherry", "cobra",   "comet",     "coyote",
    "cricket",  "dolphin",  "dragon",    "eagle",    "ferret", "fox",     "frog",      "gazelle",
    "gecko",    "giraffe",  "goose",     "hedgehog", "heron",  "hippo",   "jellyfish", "koala",
    "lemur",    "leopard",  "llama",     "lobster",  "mango",  "meerkat", "mongoose",  "moose",
    "narwhal",  "octopus",  "otter",     "owl",      "panda",  "panther", "parrot",    "penguin",
    "pickle",   "platypus", "porcupine", "possum",   "puffin", "rabbit",  "raccoon",   "rhino",
    "salmon",   "seahorse", "shark",     "skunk",    "sloth",  "snail",   "squid",     "squirrel",
    "toucan",   "turtle",   "walrus",    "weasel",   "wombat", "yak",     "zebra",
};

const Request = struct {
    id: i64,
    op: []const u8,
    cwd: ?[]const u8 = null,
    topic: ?[]const u8 = null,
    keep: ?bool = null,
};

const CreateResult = struct {
    path: []const u8,
    branch: []const u8,
    topic: []const u8,
    base: []const u8,
};

const MergeResult = struct {
    merged: bool,
    up_to_date: bool = false,
    branch: []const u8,
    text: []const u8,
};

const WorktreeEntry = struct {
    path: []const u8,
    head: []const u8 = "",
    branch: ?[]const u8 = null, // short name, e.g. "wt/angry-aardvark"
};

const WorktreeOp = struct {
    ok: bool = false,
    err: []const u8 = "",
    text: []const u8 = "",
};

// ---------------------------------------------------------------------------
// Name generation

// Lowercases, maps anything not [a-z0-9] to '-', collapses runs of '-', and
// trims leading/trailing '-'. Empty input yields an empty result.
fn sanitizeTopic(arena: Allocator, input: []const u8) ![]const u8 {
    var out = List.init(arena);
    var last_dash = false;
    for (input) |c| {
        const lc: u8 = switch (c) {
            'A'...'Z' => c + 32,
            'a'...'z', '0'...'9' => c,
            else => '-',
        };
        if (lc == '-') {
            if (last_dash) continue;
            last_dash = true;
            try out.append('-');
        } else {
            last_dash = false;
            try out.append(lc);
        }
    }
    var s = out.items;
    while (s.len > 0 and s[0] == '-') s = s[1..];
    while (s.len > 0 and s[s.len - 1] == '-') s = s[0 .. s.len - 1];
    return s;
}

fn randomTopic(arena: Allocator, rnd: *std.Random.DefaultPrng) ![]const u8 {
    const r = rnd.random();
    return std.fmt.allocPrint(arena, "{s}-{s}", .{
        ADJECTIVES[r.int(usize) % ADJECTIVES.len],
        NOUNS[r.int(usize) % NOUNS.len],
    });
}

// Seed for the name generator: the monotonic clock mixed with a stack
// address, so two creates in the same millisecond still differ. Collision
// re-rolls in opCreate guard against repeats.
fn newRng() std.Random.DefaultPrng {
    var probe: usize = 0;
    const seed = @as(u64, @bitCast(nowMs())) ^ @as(u64, @intFromPtr(&probe));
    return std.Random.DefaultPrng.init(seed);
}

// ---------------------------------------------------------------------------
// Git helpers

fn dirExists(io: std.Io, path: []const u8) bool {
    var d = std.Io.Dir.cwd().openDir(io, path, .{}) catch return false;
    d.close(io);
    return true;
}

fn branchExists(arena: Allocator, io: std.Io, root: []const u8, branch: []const u8) !bool {
    const res = try runGit(arena, io, &.{ "git", "-C", root, "show-ref", "--verify", "--quiet", branch }, 4096);
    return res.ok;
}

fn currentBranchLabel(arena: Allocator, io: std.Io, root: []const u8) ![]const u8 {
    const sym = try runGit(arena, io, &.{ "git", "-C", root, "symbolic-ref", "--quiet", "--short", "HEAD" }, 4096);
    if (sym.ok) {
        const name = mem.trim(u8, sym.stdout, " \t\r\n");
        if (name.len > 0) return name;
    }
    const hash = try runGit(arena, io, &.{ "git", "-C", root, "rev-parse", "--short", "HEAD" }, 64);
    if (hash.ok) return mem.trim(u8, hash.stdout, " \t\r\n");
    return "detached HEAD";
}

// Parses `git worktree list --porcelain` into entries. Blocks are separated
// by blank lines; a worktree block has a "worktree <path>" line, a "HEAD
// <hash>" line, and optionally a "branch refs/heads/<name>" line.
fn parseWorktrees(arena: Allocator, porcelain: []const u8) ![]WorktreeEntry {
    var entries = std.ArrayList(WorktreeEntry).empty;
    var blocks = mem.splitSequence(u8, porcelain, "\n\n");
    while (blocks.next()) |block| {
        var e = WorktreeEntry{ .path = "" };
        var lines = mem.splitScalar(u8, block, '\n');
        while (lines.next()) |line| {
            if (mem.startsWith(u8, line, "worktree ")) {
                e.path = line["worktree ".len..];
            } else if (mem.startsWith(u8, line, "HEAD ")) {
                e.head = line["HEAD ".len..];
            } else if (mem.startsWith(u8, line, "branch refs/heads/")) {
                e.branch = line["branch refs/heads/".len..];
            }
        }
        if (e.path.len > 0) try entries.append(arena, e);
    }
    return entries.items;
}

fn listWorktrees(arena: Allocator, io: std.Io, root: []const u8) ![]WorktreeEntry {
    const res = try runGit(arena, io, &.{ "git", "-C", root, "worktree", "list", "--porcelain" }, 64 * 1024);
    if (!res.ok) return error.WorktreeListFailed;
    return parseWorktrees(arena, res.stdout);
}

// Matches a topic against worktrees: branch wt/<topic> (or <topic> itself),
// or a path ending in /<topic> or /.wt/<topic>.
fn findWorktree(entries: []WorktreeEntry, topic: []const u8) ?*WorktreeEntry {
    for (entries) |*e| {
        if (e.branch) |b| {
            if (mem.eql(u8, b, topic)) return e;
            if (mem.startsWith(u8, b, "wt/") and mem.eql(u8, b[3..], topic)) return e;
        }
        if (mem.endsWith(u8, e.path, topic)) {
            const i = e.path.len - topic.len;
            if (i == 0 or e.path[i - 1] == '/') return e;
        }
    }
    return null;
}

// Ensures .wt/ is in .git/info/exclude (local, never committed) so the
// worktree directory never shows up as untracked noise in git status.
fn ensureExcluded(arena: Allocator, io: std.Io, root: []const u8) !void {
    const common_res = try runGit(arena, io, &.{ "git", "-C", root, "rev-parse", "--git-common-dir" }, 4096);
    if (!common_res.ok) return error.NoGitCommonDir;
    var common_dir = mem.trim(u8, common_res.stdout, " \t\r\n");
    if (!std.fs.path.isAbsolute(common_dir)) {
        common_dir = try std.fmt.allocPrint(arena, "{s}/{s}", .{ root, common_dir });
    }
    const exclude_path = try std.fmt.allocPrint(arena, "{s}/info/exclude", .{common_dir});

    const existing = std.Io.Dir.readFileAlloc(.cwd(), io, exclude_path, arena, .limited(64 * 1024)) catch "";
    var found = false;
    var it = mem.splitScalar(u8, existing, '\n');
    while (it.next()) |line| {
        if (mem.eql(u8, mem.trim(u8, line, " \t\r"), ".wt/")) {
            found = true;
            break;
        }
    }
    if (found) return;

    const file = try std.Io.Dir.createFileAbsolute(io, exclude_path, .{});
    defer file.close(io);
    try writeAllIo(io, file, existing);
    if (existing.len > 0 and existing[existing.len - 1] != '\n') try writeAllIo(io, file, "\n");
    try writeAllIo(io, file, ".wt/\n");
}

// ---------------------------------------------------------------------------
// create

fn opCreate(arena: Allocator, io: std.Io, cwd: []const u8, topic_arg: ?[]const u8) !WorktreeOp {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };

    const head = try runGit(arena, io, &.{ "git", "-C", root, "rev-parse", "--verify", "HEAD" }, 4096);
    if (!head.ok) return .{ .err = "repository has no commits yet; commit something first" };

    const explicit = topic_arg != null and mem.trim(u8, topic_arg.?, " \t\r\n").len > 0;
    var rng = newRng();
    const topic = if (explicit)
        (try sanitizeTopic(arena, topic_arg.?))
    else
        (try randomTopic(arena, &rng));

    if (topic.len == 0) return .{ .err = "topic must contain letters or numbers" };

    // Collision check: explicit topics error out, generated names re-roll.
    // Also reject paths that collide with an existing worktree's working tree.
    var path = try std.fmt.allocPrint(arena, "{s}/.wt/{s}", .{ root, topic });
    var branch = try std.fmt.allocPrint(arena, "wt/{s}", .{topic});
    if ((try branchExists(arena, io, root, branch)) or dirExists(io, path)) {
        if (explicit) return .{ .err = try std.fmt.allocPrint(arena, "wt/{s} already exists", .{topic}) };
        var rnd = newRng();
        var attempts: usize = 0;
        while (attempts < 25) : (attempts += 1) {
            const fresh = try randomTopic(arena, &rnd);
            branch = try std.fmt.allocPrint(arena, "wt/{s}", .{fresh});
            path = try std.fmt.allocPrint(arena, "{s}/.wt/{s}", .{ root, fresh });
            if (!(try branchExists(arena, io, root, branch)) and !dirExists(io, path)) {
                return finishCreate(arena, io, root, fresh, path, branch);
            }
        }
        return .{ .err = "could not find a free worktree name" };
    }
    return finishCreate(arena, io, root, topic, path, branch);
}

fn finishCreate(arena: Allocator, io: std.Io, root: []const u8, topic: []const u8, path: []const u8, branch: []const u8) !WorktreeOp {
    try ensureExcluded(arena, io, root);

    const add = try runGit(arena, io, &.{ "git", "-C", root, "worktree", "add", "-b", branch, path, "HEAD" }, 4096);
    if (!add.ok) {
        const err = mem.trim(u8, add.stderr, " \t\r\n");
        return .{ .err = if (err.len > 0) err else "git worktree add failed" };
    }

    const base = try currentBranchLabel(arena, io, root);
    const result = try std.json.Stringify.valueAlloc(arena, CreateResult{
        .path = path,
        .branch = branch,
        .topic = topic,
        .base = base,
    }, .{});
    return .{ .ok = true, .text = result };
}

// ---------------------------------------------------------------------------
// list

fn opList(arena: Allocator, io: std.Io, cwd: []const u8) !WorktreeOp {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };
    const entries = try listWorktrees(arena, io, root);

    // The worktree containing the caller's cwd gets the '*' marker.
    var current = root;
    for (entries) |e| {
        if (mem.startsWith(u8, cwd, e.path) and e.path.len >= current.len) current = e.path;
    }

    var out = List.init(arena);
    for (entries) |e| {
        const marker = if (mem.eql(u8, e.path, current)) "*" else " ";
        const branch = e.branch orelse "(detached)";

        const status = try runGit(arena, io, &.{ "git", "-C", e.path, "status", "--porcelain" }, 4096);
        const state = if (status.ok and mem.trim(u8, status.stdout, " \t\r\n").len > 0) "dirty" else "clean";

        const rel = if (mem.eql(u8, e.path, root))
            "."
        else if (mem.startsWith(u8, e.path, root) and e.path.len > root.len and e.path[root.len] == '/')
            e.path[root.len + 1 ..]
        else
            e.path;

        try out.appendSlice(marker);
        try out.appendSlice(" ");
        try out.appendSlice(branch);
        try out.appendNTimes(' ', @max(1, 24 - branch.len));
        try out.appendSlice(rel);
        try out.appendNTimes(' ', @max(1, 30 - rel.len));
        try out.appendSlice(state);
        try out.append('\n');
    }
    if (out.items.len > 0) out.items.len -= 1; // drop trailing newline
    return .{ .ok = true, .text = out.items };
}

// ---------------------------------------------------------------------------
// merge

fn opMerge(arena: Allocator, io: std.Io, cwd: []const u8, topic: []const u8) !WorktreeOp {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };
    const entries = try listWorktrees(arena, io, root);
    const target = findWorktree(entries, topic) orelse
        return .{ .err = try std.fmt.allocPrint(arena, "no worktree for '{s}'; /wt list to see what exists", .{topic}) };
    const branch = target.branch orelse
        return .{ .err = "worktree is on a detached HEAD; nothing to merge" };

    const current = try currentBranchLabel(arena, io, root);
    if (mem.eql(u8, branch, current)) {
        return .{ .err = try std.fmt.allocPrint(arena, "cannot merge {s} into itself; run /wt merge from the target checkout", .{branch}) };
    }

    const res = try runGit(arena, io, &.{ "git", "-C", cwd, "merge", "--no-edit", branch }, 64 * 1024);
    if (!res.ok) {
        // A failed merge with unmerged paths means real conflicts; anything
        // else is git refusing (dirty tree, etc) and its stderr says why.
        const unmerged = try runGit(arena, io, &.{ "git", "-C", cwd, "diff", "--name-only", "--diff-filter=U" }, 64 * 1024);
        if (unmerged.ok and mem.trim(u8, unmerged.stdout, " \t\r\n").len > 0) {
            const files = mem.trim(u8, unmerged.stdout, " \t\r\n");
            return .{ .err = try std.fmt.allocPrint(arena, "merge conflicts in {s}; resolve and commit", .{files}) };
        }
        const err = mem.trim(u8, res.stderr, " \t\r\n");
        return .{ .err = if (err.len > 0) err else "git merge failed" };
    }

    const stdout = res.stdout;
    const text = if (mem.indexOf(u8, stdout, "Already up to date") != null)
        try std.fmt.allocPrint(arena, "{s} already up to date in {s}", .{ branch, current })
    else if (mem.indexOf(u8, stdout, "Fast-forward") != null)
        try std.fmt.allocPrint(arena, "merged {s} into {s} (fast-forward)", .{ branch, current })
    else
        try std.fmt.allocPrint(arena, "merged {s} into {s} (merge commit)", .{ branch, current });

    const result = MergeResult{
        .merged = true,
        .up_to_date = mem.indexOf(u8, stdout, "Already up to date") != null,
        .branch = branch,
        .text = text,
    };
    const bytes = try json.Stringify.valueAlloc(arena, result, .{});
    return .{ .ok = true, .text = bytes };
}

// ---------------------------------------------------------------------------
// prune

fn opPrune(arena: Allocator, io: std.Io, cwd: []const u8, topic: []const u8) !WorktreeOp {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };
    const entries = try listWorktrees(arena, io, root);
    const target = findWorktree(entries, topic) orelse
        return .{ .err = try std.fmt.allocPrint(arena, "no worktree for '{s}'; /wt list to see what exists", .{topic}) };

    const remove = try runGit(arena, io, &.{ "git", "-C", root, "worktree", "remove", target.path }, 4096);
    if (!remove.ok) {
        const err = mem.trim(u8, remove.stderr, " \t\r\n");
        return .{ .err = if (err.len > 0) err else "git worktree remove failed" };
    }

    if (target.branch) |b| {
        const del = try runGit(arena, io, &.{ "git", "-C", root, "branch", "-d", b }, 4096);
        if (!del.ok) {
            const err = mem.trim(u8, del.stderr, " \t\r\n");
            return .{ .ok = true, .text = try std.fmt.allocPrint(arena, "removed {s}, branch {s} left behind ({s})", .{ target.path, b, if (err.len > 0) err else "not fully merged" }) };
        }
        return .{ .ok = true, .text = try std.fmt.allocPrint(arena, "removed {s}, deleted branch {s}", .{ target.path, b }) };
    }
    return .{ .ok = true, .text = try std.fmt.allocPrint(arena, "removed {s}", .{target.path}) };
}

// ---------------------------------------------------------------------------
// self-check

fn selfCheck(gpa: Allocator, io: std.Io) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const dir = try std.fmt.allocPrint(arena, "/tmp/pi-wt-selfcheck-{d}", .{nowMs()});
    const cwd_dir = std.Io.Dir.cwd();
    cwd_dir.deleteTree(io, dir) catch {};
    cwd_dir.createDirPath(io, dir) catch |err| {
        std.debug.print("FAIL: mkdir {s}: {s}\n", .{ dir, @errorName(err) });
        std.process.exit(1);
    };
    defer cwd_dir.deleteTree(io, dir) catch {};

    const fail = struct {
        fn f(cond: bool, msg: []const u8) void {
            if (!cond) {
                std.debug.print("FAIL: {s}\n", .{msg});
                std.process.exit(1);
            }
        }
    }.f;

    const init = try runGit(arena, io, &.{ "git", "init", "-q", dir }, 4096);
    fail(init.ok, "git init in temp repo");
    _ = try runGit(arena, io, &.{ "git", "-C", dir, "config", "user.email", "selfcheck@local" }, 4096);
    _ = try runGit(arena, io, &.{ "git", "-C", dir, "config", "user.name", "selfcheck" }, 4096);

    const base_path = try std.fmt.allocPrint(arena, "{s}/base.txt", .{dir});
    const write = struct {
        fn f(io2: std.Io, path: []const u8, content: []const u8) !void {
            const file = try std.Io.Dir.createFileAbsolute(io2, path, .{});
            defer file.close(io2);
            try writeAllIo(io2, file, content);
        }
    }.f;
    try write(io, base_path, "one\n");
    _ = try runGit(arena, io, &.{ "git", "-C", dir, "add", "-A" }, 4096);
    const base_commit = try runGit(arena, io, &.{ "git", "-C", dir, "commit", "-qm", "base" }, 4096);
    fail(base_commit.ok, "base commit");

    // create with an explicit topic
    const created = try opCreate(arena, io, dir, "selfcheck");
    fail(created.ok, "create worktree");
    const c = try json.parseFromSlice(CreateResult, arena, created.text, .{});
    // git canonicalizes paths (/tmp -> /private/tmp on macOS), so compare
    // against the resolved root rather than the raw temp dir.
    const root = (try gitRoot(arena, io, dir)) orelse "";
    fail(mem.eql(u8, c.value.branch, "wt/selfcheck"), "explicit topic becomes wt/selfcheck");
    fail(mem.eql(u8, c.value.path, try std.fmt.allocPrint(arena, "{s}/.wt/selfcheck", .{root})), "worktree path under .wt/");
    fail(c.value.base.len > 0, "base branch reported");
    fail(dirExists(io, c.value.path), "worktree dir exists");

    const exclude_path = try std.fmt.allocPrint(arena, "{s}/.git/info/exclude", .{dir});
    const exclude = std.Io.Dir.readFileAlloc(.cwd(), io, exclude_path, arena, .limited(64 * 1024)) catch "";
    fail(mem.indexOf(u8, exclude, ".wt/") != null, ".wt/ excluded from status");

    // agent B commits inside the worktree
    try write(io, try std.fmt.allocPrint(arena, "{s}/base.txt", .{c.value.path}), "selfcheck change\n");
    _ = try runGit(arena, io, &.{ "git", "-C", c.value.path, "add", "-A" }, 4096);
    const wt_commit = try runGit(arena, io, &.{ "git", "-C", c.value.path, "commit", "-qm", "worktree change" }, 4096);
    fail(wt_commit.ok, "commit inside worktree");

    // list shows it
    const listed = try opList(arena, io, dir);
    fail(listed.ok and mem.indexOf(u8, listed.text, "wt/selfcheck") != null, "list shows the worktree");

    // merge back fast-forwards
    const merged = try opMerge(arena, io, dir, "selfcheck");
    fail(merged.ok, "merge succeeds");
    const m = try json.parseFromSlice(MergeResult, arena, merged.text, .{});
    fail(m.value.merged and !m.value.up_to_date, "merge reports merged");
    fail(mem.indexOf(u8, m.value.text, "fast-forward") != null, "fast-forward merge");

    // prune removes worktree and branch
    const pruned = try opPrune(arena, io, dir, "selfcheck");
    fail(pruned.ok and mem.indexOf(u8, pruned.text, "deleted branch wt/selfcheck") != null, "prune deletes worktree and branch");
    fail(!dirExists(io, c.value.path), "worktree dir gone after prune");
    fail(!(try branchExists(arena, io, dir, "refs/heads/wt/selfcheck")), "branch gone after prune");

    // auto-generated name
    const auto = try opCreate(arena, io, dir, null);
    fail(auto.ok, "auto-named create works");
    const a = try json.parseFromSlice(CreateResult, arena, auto.text, .{});
    fail(mem.startsWith(u8, a.value.branch, "wt/") and a.value.branch.len > 6, "auto name is wt/<adj>-<noun>");
    fail(a.value.topic.len > 0, "auto topic reported");

    // duplicate explicit topic is rejected
    const dup = try opCreate(arena, io, dir, a.value.topic);
    fail(!dup.ok and mem.indexOf(u8, dup.err, "already exists") != null, "duplicate topic rejected");

    // merging a worktree into itself is rejected
    const second = try opCreate(arena, io, dir, "second");
    fail(second.ok, "second worktree created");
    const s = try json.parseFromSlice(CreateResult, arena, second.text, .{});
    const self_merge = try opMerge(arena, io, s.value.path, "second");
    fail(!self_merge.ok and mem.indexOf(u8, self_merge.err, "into itself") != null, "self-merge rejected");

    // conflicting changes surface as conflicts, not silent failures. The
    // worktree must branch BEFORE the main-side commit so both sides diverge
    // from the same base.
    const conflict_wt = try opCreate(arena, io, dir, "conflict");
    fail(conflict_wt.ok, "conflict worktree created");
    const cf = try json.parseFromSlice(CreateResult, arena, conflict_wt.text, .{});
    try write(io, try std.fmt.allocPrint(arena, "{s}/base.txt", .{cf.value.path}), "conflict change\n");
    _ = try runGit(arena, io, &.{ "git", "-C", cf.value.path, "add", "-A" }, 4096);
    fail((try runGit(arena, io, &.{ "git", "-C", cf.value.path, "commit", "-qm", "conflict change" }, 4096)).ok, "worktree commit");
    try write(io, base_path, "main change\n");
    _ = try runGit(arena, io, &.{ "git", "-C", dir, "add", "-A" }, 4096);
    fail((try runGit(arena, io, &.{ "git", "-C", dir, "commit", "-qm", "main change" }, 4096)).ok, "main commit");
    const conflicted = try opMerge(arena, io, dir, "conflict");
    fail(!conflicted.ok and mem.indexOf(u8, conflicted.err, "conflicts in") != null, "conflicts reported");

    // prune of an unmerged branch removes the worktree but leaves the branch
    const conflict_prune = try opPrune(arena, io, dir, "conflict");
    fail(conflict_prune.ok and mem.indexOf(u8, conflict_prune.text, "left behind") != null, "unmerged branch left behind");

    // not a repo
    const not_repo = try opCreate(arena, io, "/tmp", null);
    fail(!not_repo.ok, "non-repo rejected");

    std.debug.print("PASS: pi-wt self-check ok\n", .{});
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
        const cwd = r.cwd orelse {
            respond(arena, io, id, false, "missing cwd") catch {};
            continue;
        };

        if (mem.eql(u8, r.op, "create")) {
            const outcome = opCreate(arena, io, cwd, r.topic) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (outcome.ok) respond(arena, io, id, true, outcome.text) catch {} else respond(arena, io, id, false, outcome.err) catch {};
        } else if (mem.eql(u8, r.op, "list")) {
            const outcome = opList(arena, io, cwd) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (outcome.ok) respond(arena, io, id, true, outcome.text) catch {} else respond(arena, io, id, false, outcome.err) catch {};
        } else if (mem.eql(u8, r.op, "merge")) {
            const topic = mem.trim(u8, r.topic orelse "", " \t\r\n");
            if (topic.len == 0) {
                respond(arena, io, id, false, "missing topic") catch {};
                continue;
            }
            const outcome = opMerge(arena, io, cwd, topic) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (outcome.ok) respond(arena, io, id, true, outcome.text) catch {} else respond(arena, io, id, false, outcome.err) catch {};
        } else if (mem.eql(u8, r.op, "prune")) {
            const topic = mem.trim(u8, r.topic orelse "", " \t\r\n");
            if (topic.len == 0) {
                respond(arena, io, id, false, "missing topic") catch {};
                continue;
            }
            const outcome = opPrune(arena, io, cwd, topic) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (outcome.ok) respond(arena, io, id, true, outcome.text) catch {} else respond(arena, io, id, false, outcome.err) catch {};
        } else {
            respond(arena, io, id, false, "unknown op") catch {};
        }
    }
}
