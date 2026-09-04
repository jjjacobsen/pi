import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const STEADY_BAR_CURSOR = "\x1b[6 q";
const DEFAULT_CURSOR = "\x1b[0 q";
const SOFTWARE_CURSOR = /\x1b\[7m(.*?)\x1b\[0m/g;

class BarCursorEditor extends CustomEditor {
	render(width: number): string[] {
		return super.render(width).map((line) => line.replace(SOFTWARE_CURSOR, "$1"));
	}
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let showHardwareCursor = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent((activeTui, theme, keybindings) => {
			tui = activeTui;
			showHardwareCursor = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(true);
			tui.terminal.write(STEADY_BAR_CURSOR);
			return new BarCursorEditor(tui, theme, keybindings);
		});
	});

	pi.on("session_shutdown", () => {
		if (!tui) return;
		tui.terminal.write(DEFAULT_CURSOR);
		tui.setShowHardwareCursor(showHardwareCursor);
		tui = undefined;
	});
}
