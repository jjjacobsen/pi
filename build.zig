const std = @import("std");

// Each entry in this list becomes a binary installed to zig-out/bin/.
// Add new extension backends here as the repo grows.
const bins = .{
    .{ .name = "pi-lightpanda", .path = "src/lightpanda.zig" },
    .{ .name = "pi-commit", .path = "src/commit.zig" },
    .{ .name = "pi-lg", .path = "src/lazygit.zig" },
    .{ .name = "pi-nvim", .path = "src/nvim.zig" },
    .{ .name = "pi-peon", .path = "src/peon.zig" },
    .{ .name = "pi-usage", .path = "src/usage.zig" },
    .{ .name = "pi-vision", .path = "src/vision.zig" },
    .{ .name = "pi-search", .path = "src/search.zig" },
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

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
    }
}
