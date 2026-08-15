// pi-commit: git analysis, conventional-commit validation, and commit
// execution for the pi /commit command.
//
// The pi extension (extensions/commit.ts) sends one JSON request per line on
// stdin, we answer with one JSON response line on stdout. The extension calls
// the model itself; this backend owns everything git-related.
//
// Request line:  {"id":1,"op":"analyze","cwd":"/path/to/repo"}
//                {"id":2,"op":"validate","message":"feat(x): ..."}
//                {"id":3,"op":"commit","message":"..."}
// Response line: {"id":1,"ok":true,"result":"..."}   (analyze: +"empty":true when clean)
//                {"id":1,"ok":false,"error":"..."}   (validate errors are "- problem" lines)
//
// analyze stages everything with `git add -A` and returns a markdown context
// block for message generation: repo name, primary languages, changed files,
// diff stat, a diff digest, recent commit style, and commit guidance from
// AGENTS.md. validate checks Conventional Commits format and body substance.
// commit creates the commit with `git commit -F -` on the staged snapshot.

const std = @import("std");
const posix = std.posix;
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const CHUNK = common.CHUNK;
const nowMs = common.nowMs;
const readLine = common.readLine;
const writeAllIo = common.writeAllIo;
const respond = common.respond;
const GitResult = common.GitResult;
const runGit = common.runCmd;
const gitRoot = common.gitRoot;

const MAX_LINE = 4 * 1024 * 1024; // hard cap on a single request line
const MAX_GIT_OUT = 32 * 1024 * 1024; // cap on raw diff bytes read from git
const RAW_DIFF_LIMIT = 6 * 1024; // use the raw diff verbatim below this size
const DIGEST_LIMIT = 12 * 1024; // cap on the assembled diff digest
const CONTEXT_LIMIT = 24 * 1024; // cap on the whole analyze context

const TYPES = [_][]const u8{
    "feat",   "fix", "docs",  "refactor", "test",
    "perf",   "ci",  "chore", "build",    "style",
    "revert",
};

const Request = struct {
    id: i64,
    op: []const u8,
    cwd: ?[]const u8 = null,
    message: ?[]const u8 = null,
};

const AnalyzeOutcome = struct {
    ok: bool = false,
    empty: bool = false,
    context: []const u8 = "",
    err: []const u8 = "",
};

const CommitOutcome = struct {
    ok: bool = false,
    text: []const u8 = "",
    err: []const u8 = "",
};

// ---------------------------------------------------------------------------
// analyze// Drains a pipe into buf, keeping at most max bytes. Keeps reading past max so
// a chatty child never blocks on a full pipe.
fn drainInto(fd: posix.fd_t, buf: *List, max: usize) !void {
    var chunk: [CHUNK]u8 = undefined;
    while (true) {
        const n = try posix.read(fd, &chunk);
        if (n == 0) return;
        if (buf.items.len < max) {
            const room = max - buf.items.len;
            try buf.appendSlice(chunk[0..@min(n, room)]);
        }
    }
}

fn respondEmpty(alloc: Allocator, io: std.Io, id: i64) !void {
    try writeAllIo(io, std.Io.File.stdout(), try std.fmt.allocPrint(alloc, "{{\"id\":{d},\"ok\":true,\"empty\":true,\"result\":\"\"}}\n", .{id}));
}

// ---------------------------------------------------------------------------
// Git helpers

// Runs git with message on stdin (for `git commit -F -`).
fn runGitWithInput(arena: Allocator, io: std.Io, argv: []const []const u8, input: []const u8) !GitResult {
    var child = try std.process.spawn(io, .{
        .argv = argv,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .pipe,
    });
    errdefer child.kill(io);
    if (child.stdin) |in| {
        writeAllIo(io, in, input) catch {};
        in.close(io);
        child.stdin = null;
    }
    var out = List.init(arena);
    var err = List.init(arena);
    if (child.stdout) |o| {
        drainInto(o.handle, &out, MAX_GIT_OUT) catch {};
        o.close(io);
        child.stdout = null;
    }
    if (child.stderr) |e| {
        drainInto(e.handle, &err, 16 * 1024) catch {};
        e.close(io);
        child.stderr = null;
    }
    const term = child.wait(io) catch return error.WaitFailed;
    const ok = term == .exited and term.exited == 0;
    return .{ .ok = ok, .stdout = out.items, .stderr = err.items };
}

// ---------------------------------------------------------------------------
// analyze

fn analyzeContext(arena: Allocator, io: std.Io, cwd: []const u8) !AnalyzeOutcome {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };

    // Snapshot: stage everything now so the commit later matches what the
    // user saw when they ran /commit.
    const add = try runGit(arena, io, &.{ "git", "-C", root, "add", "-A" }, 4096);
    if (!add.ok) return .{ .err = "git add failed" };

    const files = try runGit(arena, io, &.{ "git", "-C", root, "diff", "--cached", "-M", "--name-status" }, 64 * 1024);
    if (!files.ok) return .{ .err = "git diff --name-status failed" };
    const names = mem.trim(u8, files.stdout, " \t\r\n");
    if (names.len == 0) return .{ .ok = true, .empty = true };

    const stat = try runGit(arena, io, &.{ "git", "-C", root, "diff", "--cached", "-M", "--stat" }, 64 * 1024);
    const raw_diff = try runGit(arena, io, &.{ "git", "-C", root, "diff", "--cached", "-M", "-U3" }, MAX_GIT_OUT);
    const style = try runGit(arena, io, &.{ "git", "-C", root, "log", "--pretty=format:%s", "-25" }, 8 * 1024);
    if (!stat.ok or !raw_diff.ok) return .{ .err = "git diff failed" };

    var ctx = List.init(arena);

    try ctx.appendSlice("## Repository\n");
    try ctx.appendSlice(std.fs.path.basename(root));
    try ctx.appendSlice("\n\n");

    const langs = topLanguages(arena, names) catch null;
    if (langs) |l| {
        try ctx.appendSlice("## Primary languages\n");
        try ctx.appendSlice(l);
        try ctx.appendSlice("\n\n");
    }

    try ctx.appendSlice("## Changed files\n");
    var it = mem.splitScalar(u8, names, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        var out = List.init(arena);
        for (line) |c| try out.append(if (c == '\t') ' ' else c);
        try ctx.appendSlice(try out.toOwnedSlice());
        try ctx.appendSlice("\n");
    }

    if (stat.ok and mem.trim(u8, stat.stdout, " \t\r\n").len > 0) {
        try ctx.appendSlice("\n## Diff stat\n");
        try ctx.appendSlice(stat.stdout);
        try ctx.appendSlice("\n");
    }

    try ctx.appendSlice("\n## Diff\n");
    const raw = mem.trim(u8, raw_diff.stdout, "\n");
    if (raw.len <= RAW_DIFF_LIMIT) {
        try ctx.appendSlice(raw);
    } else {
        try ctx.appendSlice(try buildDigest(arena, raw));
    }
    try ctx.appendSlice("\n");

    if (style.ok) {
        const subjects = mem.trim(u8, style.stdout, " \t\r\n");
        if (subjects.len > 0) {
            try ctx.appendSlice("\n## Recent commit style (last 25 subjects)\n");
            try ctx.appendSlice(subjects);
            try ctx.appendSlice("\n");
        }
    }

    const guide = commitGuidance(arena, io, root) catch null;
    if (guide) |g| {
        if (g.len > 0) {
            try ctx.appendSlice("\n## Repository commit guidance (AGENTS.md)\n");
            try ctx.appendSlice(g);
            try ctx.appendSlice("\n");
        }
    }

    if (ctx.items.len > CONTEXT_LIMIT) ctx.shrinkRetainingCapacity(CONTEXT_LIMIT);

    return .{ .ok = true, .context = ctx.items };
}

// Top 3 file extensions from the changed-file list, lowercase, comma-joined.
fn topLanguages(arena: Allocator, names: []const u8) !?[]const u8 {
    var counts: [64]struct { ext: []const u8, n: usize } = undefined;
    var count: usize = 0;
    var it = mem.splitScalar(u8, names, '\n');
    while (it.next()) |line| {
        if (line.len == 0) continue;
        const last_tab = mem.lastIndexOfScalar(u8, line, '\t') orelse continue;
        const path = line[last_tab + 1 ..];
        const dot = mem.lastIndexOfScalar(u8, path, '.') orelse continue;
        const ext = path[dot + 1 ..];
        if (ext.len == 0 or ext.len > 12) continue;
        var lower_buf: [16]u8 = undefined;
        var i: usize = 0;
        for (ext) |c| {
            if (i >= lower_buf.len) break;
            lower_buf[i] = if (c >= 'A' and c <= 'Z') c + 32 else c;
            i += 1;
        }
        const lower = lower_buf[0..i];
        var found = false;
        for (counts[0..count]) |*entry| {
            if (mem.eql(u8, entry.ext, lower)) {
                entry.n += 1;
                found = true;
                break;
            }
        }
        if (!found and count < counts.len) {
            counts[count] = .{ .ext = arena.dupe(u8, lower) catch continue, .n = 1 };
            count += 1;
        }
    }
    if (count == 0) return null;
    // simple selection sort of top 3
    var picked: [3][]const u8 = undefined;
    var picked_n: usize = 0;
    var used = arena.alloc(bool, count) catch return null;
    @memset(used, false);
    while (picked_n < 3) {
        var best: ?usize = null;
        for (counts[0..count], 0..) |entry, i| {
            if (used[i]) continue;
            if (best == null or entry.n > counts[best.?].n) best = i;
        }
        const b = best orelse break;
        used[b] = true;
        picked[picked_n] = counts[b].ext;
        picked_n += 1;
    }
    var out = List.init(arena);
    for (picked[0..picked_n], 0..) |ext, i| {
        if (i > 0) try out.appendSlice(", ");
        try out.appendSlice(ext);
    }
    return out.items;
}

fn containsCi(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0) return true;
    if (haystack.len < needle.len) return false;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        var j: usize = 0;
        while (j < needle.len and std.ascii.toLower(haystack[i + j]) == needle[j]) j += 1;
        if (j == needle.len) return true;
    }
    return false;
}

fn eqlCi(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        if (std.ascii.toLower(x) != std.ascii.toLower(y)) return false;
    }
    return true;
}

fn hasAlnum(s: []const u8) bool {
    for (s) |c| {
        if (std.ascii.isAlphanumeric(c)) return true;
    }
    return false;
}

const NOISE_PREFIXES = [_][]const u8{
    "//",       "#",              "/*",       "*",   "<!--", "import ", "from ", "use ", "require(",
    "export {", "export default", "package ", "end", "});",  "});;",
};

fn isNoiseLine(line: []const u8) bool {
    const l = mem.trim(u8, line, " \t");
    if (l.len < 4 or l.len > 120) return true;
    if (!hasAlnum(l)) return true;
    if (l.len == 1 and (l[0] == '{' or l[0] == '}' or l[0] == ')' or l[0] == ';' or l[0] == ',')) return true;
    for (NOISE_PREFIXES) |p| {
        if (mem.startsWith(u8, l, p)) return true;
    }
    return false;
}

const DECL_PREFIXES = [_][]const u8{
    "pub ",      "export ",    "def ",           "func ",   "fn ",        "function ", "class ",  "struct ",
    "enum ",     "interface ", "trait ",         "impl ",   "type ",      "const ",    "let ",    "var ",
    "async ",    "static ",    "private ",       "public ", "protected ", "internal ", "final ",  "abstract ",
    "override ", "@",          "case ",          "goto ",   "return ",    "throw ",    "if ",     "for ",
    "while ",    "switch ",    "catch ",         "void ",   "int ",       "bool ",     "string ", "float ",
    "double ",   "char ",      "do ",            "else ",   "new ",       "try ",      "yield ",  "await ",
    "require(",  "import(",    "module.exports",
};

fn looksLikeDecl(line: []const u8) bool {
    for (DECL_PREFIXES) |p| {
        if (mem.startsWith(u8, line, p)) return true;
    }
    return false;
}

// Compact per-file digest for diffs too big to send raw: file header, hunk
// headers (git puts the enclosing function name there), and interesting
// changed lines, preferring declaration-like lines.
fn buildDigest(arena: Allocator, raw: []const u8) ![]const u8 {
    var out = List.init(arena);
    var sections = mem.splitSequence(u8, raw, "diff --git ");
    _ = sections.next(); // preamble before the first diff header
    while (sections.next()) |section| {
        if (out.items.len >= DIGEST_LIMIT) break;
        var lines = mem.splitScalar(u8, section, '\n');
        const head = lines.next() orelse continue;
        // "a/old b/new" -> new path
        var path = head;
        if (mem.lastIndexOfScalar(u8, head, ' ')) |sp| path = head[sp + 1 ..];
        if (mem.startsWith(u8, path, "b/")) path = path[2..];

        var file = List.init(arena);
        var hunks: usize = 0;
        var interesting: usize = 0;
        var decls: usize = 0;
        while (lines.next()) |line| {
            if (out.items.len + file.items.len >= DIGEST_LIMIT) break;
            if (mem.startsWith(u8, line, "@@")) {
                if (hunks >= 8) continue;
                hunks += 1;
                try file.appendSlice("  ");
                try file.appendSlice(line);
                try file.appendSlice("\n");
                continue;
            }
            if (line.len == 0) continue;
            const c = line[0];
            if (c != '+' and c != '-') continue;
            if (mem.startsWith(u8, line, "+++") or mem.startsWith(u8, line, "---")) continue;
            const content = line[1..];
            if (isNoiseLine(content)) continue;
            if (interesting >= 14) continue;
            // keep declaration-like lines first, then fill with the rest
            if (looksLikeDecl(content) and decls < 10) {
                decls += 1;
                interesting += 1;
                try file.appendSlice("  ");
                try file.appendSlice(line);
                try file.appendSlice("\n");
            } else if (decls >= 10 and interesting - decls < 4) {
                interesting += 1;
                try file.appendSlice("  ");
                try file.appendSlice(line);
                try file.appendSlice("\n");
            }
        }
        if (file.items.len > 0) {
            try out.appendSlice("### ");
            try out.appendSlice(path);
            try out.appendSlice("\n");
            try out.appendSlice(file.items);
        }
    }
    if (out.items.len == 0) {
        // nothing survived the filter; fall back to the raw diff head
        try out.appendSlice(raw[0..@min(raw.len, DIGEST_LIMIT)]);
    }
    return out.items;
}

// Lines from AGENTS.md/CLAUDE.md mentioning commits, plus the two following
// lines for context. Capped at 2KB.
fn commitGuidance(arena: Allocator, io: std.Io, root: []const u8) !?[]const u8 {
    const names = [_][]const u8{ "AGENTS.md", "CLAUDE.md" };
    var out = List.init(arena);
    for (names) |name| {
        if (out.items.len >= 2048) break;
        const dir = std.Io.Dir.openDirAbsolute(io, root, .{}) catch continue;
        const content = dir.readFileAlloc(io, name, arena, .limited(64 * 1024)) catch continue;
        var lines = mem.splitScalar(u8, content, '\n');
        var pending: usize = 0; // context lines to carry after a match
        while (lines.next()) |line| {
            if (containsCi(line, "commit")) {
                try out.appendSlice("- ");
                try out.appendSlice(mem.trim(u8, line, " \t\r\n"));
                try out.appendSlice("\n");
                pending = 2;
            } else if (pending > 0 and mem.trim(u8, line, " \t\r\n").len > 0) {
                try out.appendSlice("  ");
                try out.appendSlice(mem.trim(u8, line, " \t\r\n"));
                try out.appendSlice("\n");
                pending -= 1;
            }
            if (out.items.len >= 2048) break;
        }
    }
    if (out.items.len == 0) return null;
    return out.items;
}

// ---------------------------------------------------------------------------
// validate

fn isVagueDescription(desc: []const u8) bool {
    var words = mem.tokenizeAny(u8, desc, " \t");
    const first = words.next() orelse return false;
    const vague_first = mem.eql(u8, first, "update") or mem.eql(u8, first, "change") or
        mem.eql(u8, first, "changes") or mem.eql(u8, first, "misc") or
        mem.eql(u8, first, "stuff") or mem.eql(u8, first, "things") or
        mem.eql(u8, first, "various");
    if (!vague_first) return false;
    while (words.next()) |w| {
        const ok = mem.eql(u8, w, "files") or mem.eql(u8, w, "file") or
            mem.eql(u8, w, "things") or mem.eql(u8, w, "thing") or
            mem.eql(u8, w, "stuff") or mem.eql(u8, w, "changes") or
            mem.eql(u8, w, "change") or mem.eql(u8, w, "various");
        if (!ok) return false;
    }
    return true;
}

fn isDiffNoiseLine(line: []const u8) bool {
    const l = mem.trim(u8, line, " \t\r\n");
    if (mem.startsWith(u8, l, "diff --git ")) return true;
    if (mem.startsWith(u8, l, "@@")) return true;
    if (mem.startsWith(u8, l, "index ") and mem.indexOf(u8, l, "..") != null) return true;
    if (mem.startsWith(u8, l, "+++ ") or mem.startsWith(u8, l, "--- ")) return true;
    return false;
}

// Returns "" when the message is valid, otherwise a "- problem" list (one
// per line) that is both shown to the user and fed back to the model for the
// retry.
fn validateMessage(arena: Allocator, message: []const u8) ![]const u8 {
    var problems = List.init(arena);
    const problem = struct {
        fn add(list: *List, text: []const u8) !void {
            try list.appendSlice("- ");
            try list.appendSlice(text);
            try list.appendSlice("\n");
        }
    }.add;
    const trimmed = mem.trim(u8, message, " \t\r\n");
    if (trimmed.len < 8) try problem(&problems, "message is too short");

    var lines = mem.splitScalar(u8, trimmed, '\n');
    const header = lines.next() orelse "";
    var body_lines: usize = 0;
    var body_len: usize = 0;
    var diff_noise = false;
    var body = List.init(arena);
    while (lines.next()) |line| {
        if (isDiffNoiseLine(line)) diff_noise = true;
        const l = mem.trim(u8, line, " \t\r\n");
        if (l.len > 0) body_lines += 1;
        body_len += l.len;
        try body.appendSlice(l);
        try body.appendSlice("\n");
    }
    const body_text = mem.trim(u8, body.items, " \t\r\n");

    if (header.len > 100) {
        try problem(&problems, "header is longer than 100 characters");
    }

    // <type>(<scope>)!: <description>
    var i: usize = 0;
    while (i < header.len and std.ascii.isLower(header[i])) i += 1;
    const type_name = header[0..i];
    var ok_type = false;
    for (TYPES) |t| {
        if (mem.eql(u8, type_name, t)) ok_type = true;
    }
    if (!ok_type) {
        try problem(&problems, "type must be one of: feat, fix, docs, refactor, test, perf, ci, chore, build, style, revert");
    }

    var rest = header[i..];
    var scope_ok = true;
    if (rest.len > 0 and rest[0] == '(') {
        const close = mem.indexOfScalar(u8, rest, ')') orelse 0;
        if (close < 2) {
            scope_ok = false;
        } else {
            const scope = rest[1..close];
            if (mem.indexOfAny(u8, scope, "()") != null) scope_ok = false;
            rest = rest[close + 1 ..];
        }
    }
    if (mem.startsWith(u8, rest, "!")) rest = rest[1..];
    if (rest.len == 0 or rest[0] != ':') {
        try problem(&problems, "header must be <type>(<scope>): <description>");
    } else {
        rest = mem.trim(u8, rest[1..], " \t");
        if (rest.len < 3) {
            try problem(&problems, "description is too short");
        } else if (isVagueDescription(rest)) {
            try problem(&problems, "description is vague (for example \"update files\"); say what actually changed");
        }
    }
    if (!scope_ok) try problem(&problems, "malformed scope in header");

    const placeholders = [_][]const u8{ "n/a", "na", "none", "no body", "see header", "see above", "tbd", "todo" };
    var placeholder = false;
    for (placeholders) |p| {
        if (eqlCi(body_text, p)) placeholder = true;
    }
    if (diff_noise) try problem(&problems, "message contains diff output, not commit text");
    if (placeholder) {
        try problem(&problems, "body is a placeholder; write what changed and why");
    } else if (body_len < 50) {
        try problem(&problems, "body is missing or too thin: explain what changed and why (motivation, decisions, tradeoffs)");
    }

    return problems.items;
}

// ---------------------------------------------------------------------------
// commit

fn commitChanges(arena: Allocator, io: std.Io, cwd: []const u8, message: []const u8) !CommitOutcome {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };

    const staged = try runGit(arena, io, &.{ "git", "-C", root, "diff", "--cached", "--name-status" }, 64 * 1024);
    if (!staged.ok or mem.trim(u8, staged.stdout, " \t\r\n").len == 0) {
        return .{ .err = "nothing is staged; run /commit again so the working tree is re-snapshotted" };
    }

    var input = List.init(arena);
    try input.appendSlice(mem.trim(u8, message, "\n"));
    try input.appendSlice("\n");

    const res = try runGitWithInput(arena, io, &.{ "git", "-C", root, "commit", "-F", "-" }, input.items);
    if (!res.ok) {
        const err = mem.trim(u8, res.stderr, " \t\r\n");
        if (err.len > 0) return .{ .err = err };
        return .{ .err = "git commit failed" };
    }

    const hash_res = try runGit(arena, io, &.{ "git", "-C", root, "rev-parse", "--short", "HEAD" }, 64);
    if (!hash_res.ok) return .{ .err = "commit created but hash lookup failed" };
    const hash = mem.trim(u8, hash_res.stdout, " \t\r\n");

    var header_it = mem.splitScalar(u8, message, '\n');
    const header = mem.trim(u8, header_it.next() orelse message, " \t\r\n");

    var out = List.init(arena);
    try out.appendSlice(hash);
    try out.appendSlice(" ");
    try out.appendSlice(header);
    return .{ .ok = true, .text = out.items };
}

// ---------------------------------------------------------------------------
// self-check

fn selfCheck(gpa: Allocator, io: std.Io) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const dir = try std.fmt.allocPrint(arena, "/tmp/pi-commit-selfcheck-{d}", .{nowMs()});
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
    const email = try runGit(arena, io, &.{ "git", "-C", dir, "config", "user.email", "selfcheck@local" }, 4096);
    fail(email.ok, "git config user.email");
    const name = try runGit(arena, io, &.{ "git", "-C", dir, "config", "user.name", "selfcheck" }, 4096);
    fail(name.ok, "git config user.name");

    const file_path = try std.fmt.allocPrint(arena, "{s}/hello.ts", .{dir});
    const file = std.Io.Dir.createFileAbsolute(io, file_path, .{}) catch |err| {
        std.debug.print("FAIL: create {s}: {s}\n", .{ file_path, @errorName(err) });
        std.process.exit(1);
    };
    defer file.close(io);
    try writeAllIo(io, file, "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n");

    const outcome = try analyzeContext(arena, io, dir);
    fail(outcome.ok and !outcome.empty, "analyze on dirty repo");
    fail(mem.indexOf(u8, outcome.context, "hello.ts") != null, "digest mentions hello.ts");
    fail(mem.indexOf(u8, outcome.context, "greet") != null, "digest shows changed symbol");

    const good = "feat(greet): add hello greeting\n\nAdd a greet function so callers can produce a greeting without duplicating the template string. The template keeps formatting consistent across call sites.";
    fail((try validateMessage(arena, good)).len == 0, "valid message passes validation");

    const vague = "chore: update files\n\nTouched a few things to keep the repo tidy.";
    fail((try validateMessage(arena, vague)).len > 0, "vague message rejected");

    const no_body = "feat: add thing";
    fail((try validateMessage(arena, no_body)).len > 0, "thin message rejected");

    const done = try commitChanges(arena, io, dir, good);
    fail(done.ok, "commit succeeds");
    fail(done.text.len > 8, "commit returns hash + header");

    const clean = try analyzeContext(arena, io, dir);
    fail(clean.ok and clean.empty, "analyze on clean repo reports empty");

    std.debug.print("PASS: pi-commit self-check ok\n", .{});
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

        if (mem.eql(u8, r.op, "analyze")) {
            const cwd = r.cwd orelse {
                respond(arena, io, id, false, "missing cwd") catch {};
                continue;
            };
            const outcome = analyzeContext(arena, io, cwd) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (!outcome.ok) {
                respond(arena, io, id, false, outcome.err) catch {};
                continue;
            }
            if (outcome.empty) {
                respondEmpty(arena, io, id) catch {};
                continue;
            }
            respond(arena, io, id, true, outcome.context) catch {};
        } else if (mem.eql(u8, r.op, "validate")) {
            const problems = validateMessage(arena, r.message orelse "") catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (problems.len == 0) {
                respond(arena, io, id, true, "ok") catch {};
            } else {
                respond(arena, io, id, false, problems) catch {};
            }
        } else if (mem.eql(u8, r.op, "commit")) {
            const msg = mem.trim(u8, r.message orelse "", " \t\r\n");
            if (msg.len == 0) {
                respond(arena, io, id, false, "empty commit message") catch {};
                continue;
            }
            const outcome = commitChanges(arena, io, r.cwd orelse "", msg) catch |err| {
                respond(arena, io, id, false, @errorName(err)) catch {};
                continue;
            };
            if (outcome.ok) {
                respond(arena, io, id, true, outcome.text) catch {};
            } else {
                respond(arena, io, id, false, outcome.err) catch {};
            }
        } else {
            respond(arena, io, id, false, "unknown op") catch {};
        }
    }
}
