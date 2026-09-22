import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Ghostty windows share a PID. A temporary OSC title identifies this terminal.
// OSC title control: https://ghostty.org/docs/vt/osc/2
export async function withBrowserPlacement(pi: ExtensionAPI, signal: AbortSignal | undefined, execute) {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return execute();

  const hyprctl = async (args) => {
    const result = await pi.exec("hyprctl", args, { timeout: 3000, signal });
    if (result.killed || result.code !== 0) throw new Error(`Browser placement failed: ${result.stderr || result.stdout}`);
    if (args[0] === "eval" && result.stdout.trim() !== "ok") throw new Error(`Browser placement failed: ${result.stdout}`);
    return result.stdout;
  };
  const clients = async () => JSON.parse(await hyprctl(["-j", "clients"]));
  const originalWindows = await clients();
  if (originalWindows.some((window) => window.class === "pi-browser")) return execute();
  if (!process.stdout.isTTY) throw new Error("Visible Hyprland browser placement requires pi in a terminal");

  const marker = `pi-browser-${randomUUID()}`;
  let terminal;
  process.stdout.write(`\x1b[22;2t\x1b]2;${marker}\x1b\\`);
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      terminal = (await clients()).find((window) => window.title === marker);
      if (terminal) break;
      await setTimeout(50, undefined, { signal });
    }
  } finally {
    process.stdout.write("\x1b[23;2t");
    if (terminal) {
      const title = originalWindows.find((window) => window.address === terminal.address).title;
      process.stdout.write(`\x1b]2;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x1b\\`);
    }
  }
  if (!terminal) throw new Error("Cannot identify the calling terminal window for browser placement");

  const selector = JSON.stringify(`address:${terminal.address}`);
  await hyprctl(["eval", `
    local terminal = assert(hl.get_window(${selector}), "Calling terminal closed")
    assert(terminal.layout and terminal.layout.name == "scrolling", "Browser placement requires the scrolling layout")
    hl.window_rule({
      name = "pi-browser-placement",
      match = { class = "^pi-browser$" },
      workspace = terminal.workspace.config_name .. " silent",
    })
  `]);

  const result = await execute();
  await hyprctl(["eval", `
    local terminal = assert(hl.get_window(${selector}), "Calling terminal closed")
    local browser
    for _, window in ipairs(hl.get_windows()) do
      if window.class == "pi-browser" then browser = window end
    end
    assert(browser, "Browser window did not appear")
    assert(browser.workspace.id == terminal.workspace.id, "Browser opened on the wrong workspace")
    assert(browser.layout and browser.layout.name == "scrolling", "Browser must be tiled")
    -- Targeted swaps preserve keyboard focus. Disable their pointer warp only
    -- during this synchronous operation, then restore the user's setting.
    local no_warps = hl.get_config("cursor:no_warps")
    hl.config({ cursor = { no_warps = true } })
    local ok, err = pcall(function()
      while browser.layout.column.index ~= terminal.layout.column.index + 1 do
        local index = browser.layout.column.index
        local next_index = index + (index <= terminal.layout.column.index and 1 or -1)
        local neighbor
        for _, window in ipairs(hl.get_workspace_windows(terminal.workspace)) do
          if window.layout and window.layout.column.index == next_index then neighbor = window end
        end
        assert(neighbor, "No adjacent browser column")
        assert(#neighbor.layout.column.windows == 1 and #browser.layout.column.windows == 1,
          "Browser placement requires single-window columns")
        hl.dsp.window.swap({ window = browser, target = neighbor })()
        assert(browser.layout.column.index ~= index, "Browser column did not move")
      end
    end)
    hl.config({ cursor = { no_warps = no_warps } })
    assert(ok, err)
  `]);
  return result;
}
