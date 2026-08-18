// pi-btw: side-thread state, prompt building, and formatting for the pi
// /btw command.
//
// The pi extension (extensions/btw.ts) sends one JSON request per line on
// stdin, we answer with one JSON response line on stdout. The glue owns the
// TUI window and the model call (provider credentials only exist inside pi);
// this backend owns every decision: what the model is told (ELI15, quick,
// brief), how the side thread history is assembled, and how the thread is
// formatted for copy / branch-to-chat.
//
// Request line:  {"id":1,"op":"open","context":"<main chat excerpt>","question":"optional"}
//                {"id":2,"op":"ask","question":"follow-up"}
//                {"id":3,"op":"answer","answer":"model response text"}
//                {"id":4,"op":"abort"}
//                {"id":5,"op":"format"}
//                {"id":6,"op":"copy"}          (pbcopy)
// Response:      {"id":1,"ok":true,"system_prompt":"...","messages":[...],"thinking":"low","max_tokens":800}
//                {"id":2,"ok":true,"messages":[...]}
//                {"id":3,"ok":true,"turns":2}
//                {"id":4,"ok":true,"turns":1}
//                {"id":5,"ok":true,"text":"..."}
//                {"id":6,"ok":true,"chars":123}
//                {"id":N,"ok":false,"error":"..."}
//
// `open` resets the thread: context (truncated) is embedded in the system
// prompt, and an optional first question starts the conversation. `ask`
// appends a question and returns the full message list to send to the model
// (system prompt plus the answered history plus the new question). `answer`
// fills the last unanswered turn. `abort` drops an unanswered turn (the glue
// calls it when the user cancels a streaming answer). `format` renders the
// thread as plain conversation text; `copy` formats and pipes it into pbcopy.

const std = @import("std");
const mem = std.mem;
const json = std.json;
const posix = std.posix;
const Allocator = std.mem.Allocator;
const common = @import("common.zig");
const List = common.List;
const readLine = common.readLine;
const writeAllIo = common.writeAllIo;

const MAX_LINE = 4 * 1024 * 1024; // hard cap on a single request line
const MAX_CONTEXT = 24 * 1024; // conversation excerpt embedded in the system prompt
const MAX_QUESTION = 8000;
const MAX_ANSWER = 32 * 1024;
const MAX_FORMAT = 64 * 1024;

const THINKING_LEVEL = "low"; // side answers must be quick
const MAX_TOKENS = 800; // hard cap on a side answer's length

const Turn = struct {
    question: []const u8 = "",
    answer: ?[]const u8 = null, // null while the answer is pending/streaming
};

// One content block of a message. Content is always `[{type:"text",text:...}]`:
// pi's message contract requires assistant content to be an array of blocks,
// not a plain string (pi's token estimator iterates blocks and crashes on
// string content).
const MessageBlock = struct {
    type: []const u8,
    text: []const u8,
};

const Message = struct {
    role: []const u8,
    content: []const MessageBlock,
};

const Request = struct {
    id: i64,
    op: []const u8,
    context: ?[]const u8 = null,
    question: ?[]const u8 = null,
    answer: ?[]const u8 = null,
};

const Response = struct {
    id: i64,
    ok: bool,
    system_prompt: ?[]const u8 = null,
    messages: ?[]const Message = null,
    thinking: ?[]const u8 = null,
    max_tokens: ?i64 = null,
    turns: ?i64 = null,
    text: ?[]const u8 = null,
    chars: ?i64 = null,
    @"error": ?[]const u8 = null,
};

// ---------------------------------------------------------------------------
// Thread state (lives across requests; reset on `open`)

var thread_arena_state: std.heap.ArenaAllocator = undefined;
var turns: std.ArrayListUnmanaged(Turn) = .empty;
var system_prompt: []const u8 = "";

fn resetThread(alloc: Allocator) void {
    _ = thread_arena_state.reset(.retain_capacity);
    turns = .empty;
    system_prompt = "";
    _ = alloc;
}

// ---------------------------------------------------------------------------
// IO helpers

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

fn dupTrunc(alloc: Allocator, s: []const u8, max: usize) []const u8 {
    const trimmed = mem.trim(u8, s, " \t\r\n");
    const end = @min(trimmed.len, max);
    return alloc.dupe(u8, trimmed[0..end]) catch "";
}

// ---------------------------------------------------------------------------
// Ops

fn buildSystemPrompt(alloc: Allocator, context: []const u8) ![]const u8 {
    return std.fmt.allocPrint(alloc,
        \\You answer quick side questions ("by the way") for a coding agent user
        \\who is in the middle of work. They want a simple explanation they can
        \\understand fast.
        \\
        \\Rules:
        \\- Explain like the user is 15 years old: plain words, short sentences,
        \\  no jargon. If a technical term is unavoidable, define it in one short
        \\  phrase.
        \\- Be brief: a few sentences, at most a short paragraph. Never write a
        \\  page.
        \\- Answer the question directly first, then add detail only if asked.
        \\- Do not claim to have changed files, run tools, or affected the main
        \\  task. You only answer the side question.
        \\- The conversation context below is background on what the user is
        \\  working on. Use it only to make the answer relevant; if the question
        \\  is unrelated to it, that is fine.
        \\
        \\<conversation_context>
        \\{s}
        \\</conversation_context>
    , .{if (context.len == 0) "No conversation context was available." else context});
}

// Messages to send for the model call: system prompt (owned separately by
// the glue) plus every answered turn as user/assistant pairs, plus the new
// question as the final user message.
fn textBlocks(alloc: Allocator, text: []const u8) ![]const MessageBlock {
    var blocks = std.ArrayListUnmanaged(MessageBlock).empty;
    try blocks.append(alloc, .{ .type = "text", .text = text });
    return blocks.items;
}

fn buildMessages(alloc: Allocator, with_question: ?[]const u8) ![]const Message {
    var out = std.ArrayListUnmanaged(Message).empty;
    for (turns.items) |turn| {
        try out.append(alloc, .{ .role = "user", .content = try textBlocks(alloc, turn.question) });
        if (turn.answer) |answer| try out.append(alloc, .{ .role = "assistant", .content = try textBlocks(alloc, answer) });
    }
    if (with_question) |question| {
        try out.append(alloc, .{ .role = "user", .content = try textBlocks(alloc, question) });
    }
    return out.items;
}

fn opOpen(alloc: Allocator, resp: *Response, req: *const Request) !void {
    resetThread(alloc);
    const context = dupTrunc(alloc, req.context orelse "", MAX_CONTEXT);
    system_prompt = try buildSystemPrompt(alloc, context);
    resp.system_prompt = system_prompt;
    resp.thinking = THINKING_LEVEL;
    resp.max_tokens = MAX_TOKENS;
    if (req.question) |question| {
        const q = dupTrunc(alloc, question, MAX_QUESTION);
        if (q.len == 0) return; // empty first question: window opens empty
        try turns.append(alloc, .{ .question = q });
        resp.messages = try buildMessages(alloc, null);
    } else {
        resp.messages = &[_]Message{};
    }
}

fn opAsk(alloc: Allocator, resp: *Response, req: *const Request) !void {
    const question = dupTrunc(alloc, req.question orelse "", MAX_QUESTION);
    if (question.len == 0) {
        fail(resp, "empty question");
        return;
    }
    // A trailing unanswered turn (error/abort race) is replaced, never
    // stacked: history must only hold answered turns plus the new question.
    if (turns.items.len > 0 and turns.items[turns.items.len - 1].answer == null) {
        turns.items[turns.items.len - 1].question = question;
    } else {
        try turns.append(alloc, .{ .question = question });
    }
    resp.messages = try buildMessages(alloc, null);
}

fn opAnswer(alloc: Allocator, resp: *Response, req: *const Request) !void {
    const answer = dupTrunc(alloc, req.answer orelse "", MAX_ANSWER);
    var i = turns.items.len;
    while (i > 0) {
        i -= 1;
        if (turns.items[i].answer == null) {
            turns.items[i].answer = answer;
            break;
        }
    }
    resp.turns = @intCast(turns.items.len);
}

fn opAbort(alloc: Allocator, resp: *Response) !void {
    var i = turns.items.len;
    while (i > 0) {
        i -= 1;
        if (turns.items[i].answer == null) {
            _ = turns.orderedRemove(i);
            break;
        }
    }
    resp.turns = @intCast(turns.items.len);
    _ = alloc;
}

fn opFormat(alloc: Allocator, resp: *Response) !void {
    var buf = List.init(alloc);
    for (turns.items) |turn| {
        const answer = turn.answer orelse continue; // unanswered turns are not part of the record
        if (buf.items.len > 0) try buf.appendSlice("\n\n");
        try buf.appendSlice(turn.question);
        try buf.appendSlice("\n");
        try buf.appendSlice(answer);
        if (buf.items.len > MAX_FORMAT) {
            try buf.appendSlice("\n\n(thread truncated)");
            break;
        }
    }
    resp.text = buf.items;
}

fn opCopy(io: std.Io, alloc: Allocator, resp: *Response) !void {
    if (turns.items.len == 0) {
        fail(resp, "nothing to copy");
        return;
    }
    var format_resp = Response{ .id = resp.id, .ok = true };
    try opFormat(alloc, &format_resp);
    const text = format_resp.text orelse "";

    const bin = "pbcopy";
    var child = std.process.spawn(io, .{
        .argv = &.{bin},
        .stdin = .pipe,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch {
        fail(resp, "pbcopy not found; copy the window text manually");
        return;
    };
    errdefer child.kill(io) catch {};

    if (child.stdin) |stdin_file| {
        writeAllIo(io, stdin_file, text) catch {};
        stdin_file.close(io);
        child.stdin = null;
    }
    const term = child.wait(io) catch {
        fail(resp, "pbcopy failed");
        return;
    };
    if (term != .exited or term.exited != 0) {
        fail(resp, "pbcopy failed");
        return;
    }
    resp.chars = @intCast(text.len);
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    thread_arena_state = std.heap.ArenaAllocator.init(gpa);
    defer thread_arena_state.deinit();
    const thread_alloc = thread_arena_state.allocator();

    var req_arena_state = std.heap.ArenaAllocator.init(gpa);
    defer req_arena_state.deinit();
    const req_alloc = req_arena_state.allocator();

    var line_buf = List.init(gpa);
    defer line_buf.deinit();

    while (true) {
        _ = req_arena_state.reset(.retain_capacity);
        const line = readLine(posix.STDIN_FILENO, &line_buf, MAX_LINE, req_alloc, null) catch |err| {
            std.debug.print("pi-btw: read error: {s}\n", .{@errorName(err)});
            return;
        } orelse return; // stdin EOF: the glue is gone, exit

        const parsed = json.parseFromSlice(Request, req_alloc, line, .{}) catch {
            try common.respond(req_alloc, io, -1, false, "bad request");
            continue;
        };
        const req = parsed.value;

        var resp = Response{ .id = req.id, .ok = true };
        const handle: enum { open, ask, answer, abort, format, copy, unknown } = blk: {
            if (mem.eql(u8, req.op, "open")) break :blk .open;
            if (mem.eql(u8, req.op, "ask")) break :blk .ask;
            if (mem.eql(u8, req.op, "answer")) break :blk .answer;
            if (mem.eql(u8, req.op, "abort")) break :blk .abort;
            if (mem.eql(u8, req.op, "format")) break :blk .format;
            if (mem.eql(u8, req.op, "copy")) break :blk .copy;
            break :blk .unknown;
        };
        switch (handle) {
            .open => opOpen(thread_alloc, &resp, &req) catch |err| fail(&resp, @errorName(err)),
            .ask => opAsk(thread_alloc, &resp, &req) catch |err| fail(&resp, @errorName(err)),
            .answer => opAnswer(thread_alloc, &resp, &req) catch |err| fail(&resp, @errorName(err)),
            .abort => opAbort(thread_alloc, &resp) catch |err| fail(&resp, @errorName(err)),
            .format => opFormat(thread_alloc, &resp) catch |err| fail(&resp, @errorName(err)),
            .copy => opCopy(io, thread_alloc, &resp) catch |err| fail(&resp, @errorName(err)),
            .unknown => fail(&resp, "unknown op"),
        }
        respondJson(req_alloc, io, &resp) catch {
            std.debug.print("pi-btw: write error\n", .{});
            return;
        };
    }
}
