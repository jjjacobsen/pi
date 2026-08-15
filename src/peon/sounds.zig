// pi-peon sound library: generated from the peon and peasant OpenPeon pack
// manifests (Orc Peon by tonyyont, Human Peasant by thomasKn, CC-BY-NC-4.0).
// Only the five kept categories are included. Regenerate from the packs by
// re-running the copy + jq generation (see docs/architecture.md).

pub const Sound = struct {
    name: []const u8,
    categories: []const []const u8,
    bytes: []const u8,
};

pub const sounds = [_]Sound{
    .{ .name = "PeasantAngry1.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeasantAngry1.wav") },
    .{ .name = "PeasantAngry2.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeasantAngry2.wav") },
    .{ .name = "PeasantAngry3.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeasantAngry3.wav") },
    .{ .name = "PeasantAngry4.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeasantAngry4.wav") },
    .{ .name = "PeasantAngry5.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeasantAngry5.wav") },
    .{ .name = "PeasantReady1.wav", .categories = &.{
        "session.start",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeasantReady1.wav") },
    .{ .name = "PeasantWhat1.wav", .categories = &.{
        "input.required",
        "session.start",
    }, .bytes = @embedFile("sounds/PeasantWhat1.wav") },
    .{ .name = "PeasantWhat2.wav", .categories = &.{
        "input.required",
        "session.start",
    }, .bytes = @embedFile("sounds/PeasantWhat2.wav") },
    .{ .name = "PeasantWhat3.wav", .categories = &.{
        "input.required",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeasantWhat3.wav") },
    .{ .name = "PeasantYes1.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeasantYes1.wav") },
    .{ .name = "PeasantYes2.wav", .categories = &.{
        "task.acknowledge",
    }, .bytes = @embedFile("sounds/PeasantYes2.wav") },
    .{ .name = "PeasantYes3.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeasantYes3.wav") },
    .{ .name = "PeasantYes4.wav", .categories = &.{
        "task.acknowledge",
    }, .bytes = @embedFile("sounds/PeasantYes4.wav") },
    .{ .name = "PeasantYesAttack1.wav", .categories = &.{
        "task.acknowledge",
    }, .bytes = @embedFile("sounds/PeasantYesAttack1.wav") },
    .{ .name = "PeasantYesAttack2.wav", .categories = &.{
        "task.acknowledge",
    }, .bytes = @embedFile("sounds/PeasantYesAttack2.wav") },
    .{ .name = "PeasantYesAttack3.wav", .categories = &.{
        "task.error",
    }, .bytes = @embedFile("sounds/PeasantYesAttack3.wav") },
    .{ .name = "PeasantYesAttack4.wav", .categories = &.{
        "resource.limit",
        "task.error",
    }, .bytes = @embedFile("sounds/PeasantYesAttack4.wav") },
    .{ .name = "PeonAngry1.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeonAngry1.wav") },
    .{ .name = "PeonAngry2.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeonAngry2.wav") },
    .{ .name = "PeonAngry3.wav", .categories = &.{
        "user.spam",
    }, .bytes = @embedFile("sounds/PeonAngry3.wav") },
    .{ .name = "PeonAngry4.wav", .categories = &.{
        "task.error",
    }, .bytes = @embedFile("sounds/PeonAngry4.wav") },
    .{ .name = "PeonDeath.wav", .categories = &.{
        "task.error",
    }, .bytes = @embedFile("sounds/PeonDeath.wav") },
    .{ .name = "PeonReady1.wav", .categories = &.{
        "session.start",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonReady1.wav") },
    .{ .name = "PeonWhat1.wav", .categories = &.{
        "input.required",
        "session.start",
    }, .bytes = @embedFile("sounds/PeonWhat1.wav") },
    .{ .name = "PeonWhat3.wav", .categories = &.{
        "input.required",
        "session.start",
    }, .bytes = @embedFile("sounds/PeonWhat3.wav") },
    .{ .name = "PeonWhat4.wav", .categories = &.{
        "input.required",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonWhat4.wav") },
    .{ .name = "PeonYes1.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonYes1.wav") },
    .{ .name = "PeonYes2.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonYes2.wav") },
    .{ .name = "PeonYes3.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonYes3.wav") },
    .{ .name = "PeonYes4.wav", .categories = &.{
        "task.acknowledge",
    }, .bytes = @embedFile("sounds/PeonYes4.wav") },
    .{ .name = "PeonYesAttack1.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonYesAttack1.wav") },
    .{ .name = "PeonYesAttack2.wav", .categories = &.{
        "task.acknowledge",
    }, .bytes = @embedFile("sounds/PeonYesAttack2.wav") },
    .{ .name = "PeonYesAttack3.wav", .categories = &.{
        "task.acknowledge",
        "task.complete",
    }, .bytes = @embedFile("sounds/PeonYesAttack3.wav") },
};

pub const Category = enum { session_start, task_acknowledge, task_complete, task_error, user_spam };

pub const by_category = [_][]const *const Sound{
    &.{
        &sounds[5],
        &sounds[6],
        &sounds[7],
        &sounds[22],
        &sounds[23],
        &sounds[24],
    },
    &.{
        &sounds[9],
        &sounds[10],
        &sounds[11],
        &sounds[12],
        &sounds[13],
        &sounds[14],
        &sounds[26],
        &sounds[27],
        &sounds[28],
        &sounds[29],
        &sounds[30],
        &sounds[31],
        &sounds[32],
    },
    &.{
        &sounds[5],
        &sounds[8],
        &sounds[9],
        &sounds[11],
        &sounds[22],
        &sounds[25],
        &sounds[26],
        &sounds[27],
        &sounds[28],
        &sounds[30],
        &sounds[32],
    },
    &.{
        &sounds[15],
        &sounds[16],
        &sounds[20],
        &sounds[21],
    },
    &.{
        &sounds[0],
        &sounds[1],
        &sounds[2],
        &sounds[3],
        &sounds[4],
        &sounds[17],
        &sounds[18],
        &sounds[19],
    },
};
