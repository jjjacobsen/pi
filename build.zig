const std = @import("std");

// Each entry in this list becomes a binary installed to zig-out/bin/.
// Add new extension backends here as the repo grows.
const bins = .{
    .{ .name = "pi-browser", .path = "src/browser.zig" },
    .{ .name = "pi-commit", .path = "src/commit.zig" },
    .{ .name = "pi-lg", .path = "src/lazygit.zig" },
    .{ .name = "pi-goal", .path = "src/goal.zig" },
    .{ .name = "pi-peon", .path = "src/peon.zig" },
    .{ .name = "pi-wt", .path = "src/wt.zig" },
    .{ .name = "pi-vision", .path = "src/vision.zig" },
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const run_step = b.step("run", "Run pi-browser (pass --self-check for the self test)");

    inline for (bins) |bin| {
        const exe = b.addExecutable(.{
            .name = bin.name,
            .root_module = b.createModule(.{
                .root_source_file = b.path(bin.path),
                .target = target,
                .optimize = optimize,
            }),
        });
        b.installArtifact(exe);

        const run = b.addRunArtifact(exe);
        if (b.args) |args| run.addArgs(args);
        run_step.dependOn(&run.step);
    }
}
