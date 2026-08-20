// pi-commit: git analysis, conventional-commit validation, and commit
// execution for the pi /commit command.
//
// The pi extension (extensions/commit.ts) spawns this binary once per op: one
// JSON request as a single argv element, one JSON envelope on stdout, exit
// 0/1. The extension calls the model itself; this backend owns everything
// git-related. One-shot, stateless, no persistent process.
//
// Request:  {"op":"analyze","cwd":"/path/to/repo"}   (one JSON argv element)
//           {"op":"validate","message":"feat(x): ..."}
//           {"op":"commit","message":"..."}
// Response: {"ok":true,"result":"..."}   (analyze: "" when nothing is staged)
//           {"ok":false,"error":"..."}   (validate errors are "- problem" lines)
//
// analyze blocks while goal.md or handoff.md exists, then stages everything
// with `git add -A` and returns a markdown context block for message generation:
// repo name, primary languages, changed files,
// diff stat, a diff digest, recent commit style, and commit guidance from
// AGENTS.md. validate checks Conventional Commits format and body substance.
// commit creates the commit with `git commit -F -` on the staged snapshot.

const std = @import("std");
const mem = std.mem;
const json = std.json;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const writeAllIo = common.writeAllIo;
const respondExit = common.respondExit;
const respondOutcomeExit = common.respondOutcomeExit;
const Outcome = common.Outcome;
const GitResult = common.GitResult;
const runGit = common.runCmd;
const gitRoot = common.gitRoot;

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
    const stdout_file = child.stdout orelse return error.PipeFailed;
    const stderr_file = child.stderr orelse return error.PipeFailed;
    // Drain stdout and stderr concurrently: reading one pipe to EOF before
    // the other deadlocks when a verbose pre-commit hook fills stderr while
    // git's stdout is still being read. MultiReader batches reads across all
    // streams. The buffers grow unbounded (commit output is small in
    // practice), so the results are capped after the drain.
    var stream_buffer: std.Io.File.MultiReader.Buffer(2) = undefined;
    var mr: std.Io.File.MultiReader = undefined;
    mr.init(arena, io, stream_buffer.toStreams(), &[_]std.Io.File{ stdout_file, stderr_file });
    defer mr.deinit();
    mr.fillRemaining(.none) catch {};
    const out = mr.toOwnedSlice(0) catch &[_]u8{};
    const err = mr.toOwnedSlice(1) catch &[_]u8{};
    stdout_file.close(io);
    stderr_file.close(io);
    child.stdout = null;
    child.stderr = null;
    const term = child.wait(io) catch return error.WaitFailed;
    const ok = term == .exited and term.exited == 0;
    return .{
        .ok = ok,
        .stdout = out[0..@min(out.len, MAX_GIT_OUT)],
        .stderr = err[0..@min(err.len, 16 * 1024)],
    };
}

// ---------------------------------------------------------------------------
// analyze

fn analyzeContext(arena: Allocator, io: std.Io, cwd: []const u8) !AnalyzeOutcome {
    const root = (try gitRoot(arena, io, cwd)) orelse
        return .{ .err = "not a git repository" };

    const dir = try std.Io.Dir.openDirAbsolute(io, root, .{});
    defer dir.close(io);
    for ([_][]const u8{ "goal.md", "handoff.md" }) |name| {
        _ = dir.statFile(io, name, .{}) catch |err| switch (err) {
            error.FileNotFound => continue,
            else => return err,
        };
        return .{ .err = try std.fmt.allocPrint(arena, "{s} still exists; remove it before committing", .{name}) };
    }

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
        defer dir.close(io); // one fd per guidance file; must not leak across /commit runs
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
// ops (one-shot dispatch)

fn opAnalyze(arena: Allocator, io: std.Io, req: Request) !Outcome {
    const cwd = req.cwd orelse return .{ .ok = false, .err = "missing cwd" };
    const outcome = try analyzeContext(arena, io, cwd);
    if (!outcome.ok) return .{ .ok = false, .err = outcome.err };
    // An empty result string signals nothing staged, which the glue turns
    // into an info notify rather than an error. The context is never empty
    // when files changed, so the marker is unambiguous.
    if (outcome.empty) return .{ .ok = true, .text = "" };
    return .{ .ok = true, .text = outcome.context };
}

fn opValidate(arena: Allocator, req: Request) !Outcome {
    const problems = try validateMessage(arena, req.message orelse "");
    if (problems.len == 0) return .{ .ok = true, .text = "ok" };
    return .{ .ok = false, .err = problems };
}

fn opCommit(arena: Allocator, io: std.Io, req: Request) !Outcome {
    const cwd = req.cwd orelse return .{ .ok = false, .err = "missing cwd" };
    const msg = mem.trim(u8, req.message orelse "", " \t\r\n");
    if (msg.len == 0) return .{ .ok = false, .err = "empty commit message" };
    const outcome = try commitChanges(arena, io, cwd, msg);
    if (outcome.ok) return .{ .ok = true, .text = outcome.text };
    return .{ .ok = false, .err = outcome.err };
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    const argv = init.minimal.args.vector;
    if (argv.len < 2) {
        std.debug.print("usage: pi-commit '<request json>'\n", .{});
        std.process.exit(2);
    }

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const req = json.parseFromSlice(Request, arena, std.mem.sliceTo(argv[1], 0), .{ .ignore_unknown_fields = true }) catch |err|
        respondExit(arena, io, false, @errorName(err));

    const outcome = if (mem.eql(u8, req.value.op, "analyze"))
        opAnalyze(arena, io, req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else if (mem.eql(u8, req.value.op, "validate"))
        opValidate(arena, req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else if (mem.eql(u8, req.value.op, "commit"))
        opCommit(arena, io, req.value) catch |err| respondExit(arena, io, false, @errorName(err))
    else
        respondExit(arena, io, false, "unknown op");

    respondOutcomeExit(arena, io, outcome);
}
