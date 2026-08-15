/**
 * /footer - custom status footer (opencode-style, minimal)
 *
 * Replaces pi's built-in footer with a cleaner two-line layout:
 *   line 1:  π  ~/Projects/pi  main            (workspace, git branch)
 *   line 2:  ↑26 ↓44 $0.000 1.0%/1.0M 12.4 tok/s   ...   deepseek-v4-flash • max
 *
 * vs the built-in footer this drops the R (cache read), W (cache write),
 * CH (cache hit %) and (auto) compaction segments, and adds a tok/s
 * readout: live while streaming, frozen at the last value once idle.
 * Model + reasoning level stay right-aligned.
 *
 * Pure TS glue, no Zig backend: everything comes from the extension API
 * (ctx.sessionManager / ctx.getContextUsage / ctx.model) plus
 * footerData (git branch, extension statuses). Nerd Font icons used:
 * fa-folder U+F07B, fa-code-fork U+F126, fa-gauge U+F0E4 (all present in
 * FiraCode Nerd Font). Enabled at session start; /footer toggles.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Nerd Font glyphs (verified against FiraCode Nerd Font)
const ICONS = {
	folder: "\u{F07B}", // nf-fa-folder
	git: "\u{F126}", // nf-fa-code_fork
	gauge: "\u{F0E4}", // nf-fa-gauge
};

// Subscription-billed providers: keep the $ segment visible even at $0.000
const SUBSCRIPTION_PROVIDERS = new Set(["anthropic", "github-copilot", "kimi-coding", "openai-codex", "xai"]);

// Rough chars-per-token for the live tok/s estimate
const CHARS_PER_TOKEN = 4;

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
let lastTokPerSec: string | null = null;
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
// tok/s (live while streaming, frozen at the last value when idle)
// =============================================================================

function freezeTokPerSec(perSec: number): void {
	if (perSec < 0.1) return;
	lastTokPerSec = perSec >= 100 ? `${Math.round(perSec)}` : perSec.toFixed(1);
	streamFrozen = true;
}

function currentTokPerSec(): string | null {
	if (stream && streaming) {
		const now = Date.now();
		const elapsedMs = now - stream.startMs;
		if (elapsedMs >= 1000) {
			const first = stream.samples[0]!;
			const last = stream.samples[stream.samples.length - 1]!;
			let perSec: number;
			if (last.t > first.t && now - first.t >= 2000) {
				perSec = ((last.chars - first.chars) / CHARS_PER_TOKEN) / ((last.t - first.t) / 1000);
			} else {
				perSec = (stream.chars / CHARS_PER_TOKEN) / (elapsedMs / 1000);
			}
			freezeTokPerSec(perSec);
		}
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
	let line1 = theme.fg("accent", "π") + "  " + theme.fg("dim", `${ICONS.folder} ${formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE || "")}`);
	const branch = footerData.getGitBranch();
	if (branch) line1 += "  " + theme.fg("success", `${ICONS.git} ${branch}`);
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) line1 += theme.fg("dim", ` • ${sessionName}`);
	lines.push(truncateToWidth(line1, width, theme.fg("dim", "...")));

	// Line 2 left: token/cost/context stats
	const { input, output, cost } = sessionTotals(ctx);
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercent = contextUsage?.percent;
	const contextDisplay =
		contextPercent === null || contextPercent === undefined
			? `?/${formatTokens(contextWindow)}`
			: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
	const contextColor: "error" | "warning" | "dim" =
		contextPercent === null || contextPercent === undefined
			? "dim"
			: contextPercent > 90
				? "error"
				: contextPercent > 70
					? "warning"
					: "dim";

	const parts: string[] = [];
	parts.push(theme.fg("dim", `↑${formatTokens(input)} ↓${formatTokens(output)}`));
	const isSubscription = ctx.model ? SUBSCRIPTION_PROVIDERS.has(ctx.model.provider) : false;
	if (cost > 0 || isSubscription) parts.push(theme.fg("dim", `$${cost.toFixed(3)}`));
	parts.push(theme.fg(contextColor, contextDisplay));
	// tok/s last so the rest of the line never shifts when it appears
	const tokPerSec = currentTokPerSec();
	if (tokPerSec !== null) parts.push(theme.fg("accent", `${ICONS.gauge} ${tokPerSec} tok/s`));
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
		while (stream.samples.length > 2 && now - stream.samples[0]!.t > 5000) stream.samples.shift();
		if (footerTui) footerTui.requestRender();
	});

	pi.on("message_end", () => {
		if (!streaming) return;
		streaming = false;
		// Freeze the final value: keep the last live reading, or fall back to
		// the stream's overall average when it was too short to measure live.
		if (!streamFrozen && stream && stream.chars > 0) {
			const elapsedMs = Date.now() - stream.startMs;
			if (elapsedMs > 0) freezeTokPerSec((stream.chars / CHARS_PER_TOKEN) / (elapsedMs / 1000));
		}
		if (footerTui) footerTui.requestRender();
	});

	const rerender = () => {
		if (footerTui) footerTui.requestRender();
	};
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("session_info_changed", rerender);

	pi.on("session_start", (_event, ctx) => {
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
