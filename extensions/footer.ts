/**
 * /footer - custom status footer (opencode-style, minimal)
 *
 * Replaces pi's built-in footer with a cleaner two-line layout:
 *   line 1:  π  ~/Projects/pi  main            (workspace, git branch)
 *   line 2:  ↑26 ↓44 $0.000 38,234/1.0M 12.4 tok/s   ...   deepseek-v4-flash • max
 *
 * vs the built-in footer this drops the R (cache read), W (cache write),
 * CH (cache hit %) and (auto) compaction segments, and adds a tok/s
 * readout: always visible (starts at 0.0 until the first stream), live
 * while streaming, frozen at the last value once idle. The live value is a
 * rolling average over the last ~15s of streaming, excluding downtime
 * pauses, so it reads steady instead of jumping chunk to chunk.
 * Model + reasoning level stay right-aligned.
 *
 * Context is shown as absolute tokens over the window (38,234/1.0M) instead
 * of a percent; ctx.getContextUsage() already handles compaction correctly
 * (tokens: null right after /compact until the next LLM response, shown as
 * ?/1.0M, then anchored on the first post-compaction response's verified
 * usage). A session_compact listener re-renders so the ?/1.0M state appears
 * immediately instead of lingering stale until the next stream.
 *
 * Pure TS glue, no Zig backend: everything comes from the extension API
 * (ctx.sessionManager / ctx.getContextUsage / ctx.model) plus
 * footerData (git branch, extension statuses). Nerd Font icons used:
 * fae-pi U+E22C, fa-folder U+F07B, fa-code-fork U+F126 (all present in
 * FiraCode Nerd Font). Enabled at session start; /footer toggles.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Nerd Font glyphs (verified against FiraCode Nerd Font)
const ICONS = {
	pi: "\u{e22c}", // fae-pi
	folder: "\u{F07B}", // nf-fa-folder
	git: "\u{F126}", // nf-fa-code_fork
};

// Cost is always shown, starting at $0.000 before the first billed response

// Rough chars-per-token for the live tok/s estimate
const CHARS_PER_TOKEN = 4;
// Tok/s smoothing: rolling average over SAMPLE_WINDOW_MS of history, counting
// only active streaming time (inter-sample gaps > MAX_GAP_MS are downtime and
// are excluded from the average)
const SAMPLE_WINDOW_MS = 15000;
const MAX_GAP_MS = 2000;
const MIN_ACTIVE_MS = 2000;

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

interface StreamState {
	messageTimestamp: number;
	startMs: number;
	chars: number;
	samples: { t: number; chars: number }[];
}

let footerEnabled = true;
let footerTui: TUI | null = null;
let stream: StreamState | null = null;
let streaming = false;
let lastTokPerSec = "0.0"; // always shown; "0.0" until the first measurement
let streamFrozen = false; // a tok/s value was frozen during the current stream

// =============================================================================
// Formatting helpers
// =============================================================================

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function sessionTotals(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				input += entry.message.usage.input;
				output += entry.message.usage.output;
				cost += entry.message.usage.cost.total;
			} else if (entry.message.role === "toolResult" && entry.message.usage) {
				input += entry.message.usage.input;
				output += entry.message.usage.output;
				cost += entry.message.usage.cost.total;
			}
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			input += entry.usage.input;
			output += entry.usage.output;
			cost += entry.usage.cost.total;
		}
	}
	return { input, output, cost };
}

// =============================================================================
// tok/s (always visible, resets to 0.0 per session; live while streaming,
// frozen at the last value when idle)
//
// The reading is a rolling average over the last ~15s of streaming, so a
// single burst or hiccup doesn't move it much. Only active streaming time
// counts toward the average: inter-sample gaps longer than MAX_GAP_MS are
// treated as downtime (pauses between tool calls, network stalls) and
// excluded, so a pause doesn't drag the reading toward 0.
// =============================================================================

function freezeTokPerSec(perSec: number): void {
	if (perSec < 0.1) return;
	lastTokPerSec = perSec >= 100 ? `${Math.round(perSec)}` : perSec.toFixed(1);
	streamFrozen = true;
}

function activeRatePerSec(samples: { t: number; chars: number }[]): number | null {
	// Average token rate over the active streaming time in the sample window.
	// Inter-sample gaps longer than MAX_GAP_MS are downtime and don't count
	// toward the denominator; returns null until MIN_ACTIVE_MS accumulates.
	let activeMs = 0;
	for (let i = 1; i < samples.length; i++) {
		const gap = samples[i]!.t - samples[i - 1]!.t;
		if (gap <= MAX_GAP_MS) activeMs += gap;
	}
	if (activeMs < MIN_ACTIVE_MS) return null;
	const chars = samples[samples.length - 1]!.chars - samples[0]!.chars;
	if (chars <= 0) return null;
	return (chars / CHARS_PER_TOKEN) / (activeMs / 1000);
}

function currentTokPerSec(): string {
	if (stream && streaming) {
		const perSec = activeRatePerSec(stream.samples);
		if (perSec !== null) freezeTokPerSec(perSec);
	}
	return lastTokPerSec;
}

// =============================================================================
// Rendering
// =============================================================================

function justify(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const minPad = 2;
	if (leftWidth + minPad + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	const available = width - leftWidth - minPad;
	if (available > 0) {
		const truncatedRight = truncateToWidth(right, available, "");
		return left + " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight))) + truncatedRight;
	}
	return truncateToWidth(left, width, "...");
}

function renderFooter(ctx: ExtensionContext, theme: Theme, footerData: FooterData, width: number): string[] {
	const lines: string[] = [];

	// Line 1: workspace — π  folder ~/path  git branch
	let line1 = theme.fg("accent", ICONS.pi) + "  " + theme.fg("dim", `${ICONS.folder} ${formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE || "")}`);
	const branch = footerData.getGitBranch();
	if (branch) line1 += "  " + theme.fg("success", `${ICONS.git} ${branch}`);
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) line1 += theme.fg("dim", ` • ${sessionName}`);
	lines.push(truncateToWidth(line1, width, theme.fg("dim", "...")));

	// Line 2 left: token/cost/context stats
	const { input, output, cost } = sessionTotals(ctx);
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextTokens = contextUsage?.tokens ?? null;
	const contextPercent = contextTokens !== null && contextWindow > 0 ? (contextTokens / contextWindow) * 100 : null;
	const contextDisplay =
		contextTokens === null
			? `?/${formatTokens(contextWindow)}`
			: `${contextTokens.toLocaleString("en-US")}/${formatTokens(contextWindow)}`;
	const contextColor: "error" | "warning" | "dim" =
		contextPercent === null
			? "dim"
			: contextPercent > 90
				? "error"
				: contextPercent > 70
					? "warning"
					: "dim";

	const parts: string[] = [];
	parts.push(theme.fg("dim", `↑${formatTokens(input)} ↓${formatTokens(output)}`));
	parts.push(theme.fg("dim", `$${cost.toFixed(3)}`));
	parts.push(theme.fg(contextColor, contextDisplay));
	// tok/s last so the rest of the line never shifts when it appears
	parts.push(theme.fg("dim", `${currentTokPerSec()} tok/s`));
	const left = parts.join("  ");

	// Line 2 right: model + reasoning level
	const model = ctx.model;
	const modelName = model?.id || "no-model";
	let right = "";
	if (model && footerData.getAvailableProviderCount() > 1) right += theme.fg("dim", `(${model.provider}) `);
	right += theme.fg("accent", modelName);
	if (model?.reasoning) {
		const level = ctx.thinkingLevel || "off";
		right += theme.fg("dim", ` • ${level === "off" ? "thinking off" : level}`);
	}
	lines.push(justify(left, right, width));

	// Line 3: extension statuses (only when set), same as built-in footer
	const statuses = footerData.getExtensionStatuses();
	if (statuses.size > 0) {
		const sorted = Array.from(statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		lines.push(truncateToWidth(theme.fg("dim", sorted.join(" ")), width, theme.fg("dim", "...")));
	}

	return lines;
}

function enableFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		footerTui = tui;
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: () => {
				if (footerTui === tui) footerTui = null;
				unsubscribe();
			},
			invalidate: () => {},
			render: (width: number) => renderFooter(ctx, theme, footerData, width),
		};
	});
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.on("message_update", (event) => {
		const ev = event.assistantMessageEvent;
		if (!stream || stream.messageTimestamp !== event.message.timestamp) {
			stream = { messageTimestamp: event.message.timestamp, startMs: Date.now(), chars: 0, samples: [] };
			streaming = true;
			streamFrozen = false;
		}
		if (ev.type === "text_delta" || ev.type === "thinking_delta") stream.chars += ev.delta.length;
		const now = Date.now();
		stream.samples.push({ t: now, chars: stream.chars });
		while (stream.samples.length > 2 && now - stream.samples[0]!.t > SAMPLE_WINDOW_MS) stream.samples.shift();
		if (footerTui) footerTui.requestRender();
	});

	pi.on("message_end", () => {
		if (!streaming) return;
		streaming = false;
		// Freeze the final value: keep the last live reading, or fall back to the
		// stream's overall average when it was too short for a windowed one.
		// The fallback includes any brief downtime, but for such short streams
		// that's negligible.
		if (!streamFrozen && stream && stream.chars > 0) {
			const perSec = activeRatePerSec(stream.samples);
			if (perSec !== null) freezeTokPerSec(perSec);
			else {
				const elapsedMs = Date.now() - stream.startMs;
				if (elapsedMs > 0) freezeTokPerSec((stream.chars / CHARS_PER_TOKEN) / (elapsedMs / 1000));
			}
		}
		if (footerTui) footerTui.requestRender();
	});

	const rerender = () => {
		if (footerTui) footerTui.requestRender();
	};
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("session_info_changed", rerender);
	// Re-render right after /compact: getContextUsage() flips to tokens: null
	// (displayed ?/1.0M) and session_info_changed does not fire for compaction
	pi.on("session_compact", rerender);

	pi.on("session_start", (_event, ctx) => {
		lastTokPerSec = "0.0"; // fresh session starts at 0.0, not a stale frozen value
		if (footerEnabled && ctx.mode === "tui") enableFooter(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle the custom footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			footerEnabled = !footerEnabled;
			if (footerEnabled) enableFooter(ctx);
			else ctx.ui.setFooter(undefined);
			ctx.ui.notify(footerEnabled ? "Custom footer enabled" : "Default footer restored", "info");
		},
	});
}
