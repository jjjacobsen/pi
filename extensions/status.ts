/**
 * /status - Live OpenAI Codex and OpenCode Go quota limits
 *
 * Adapted from omp (can1357/oh-my-pi)
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { resolveCodexAuth } from "./lib/toolkit";

const TIMEOUT_MS = 30_000;
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_URL = "https://opencode.ai/zen/go/v1/usage";

interface LimitInfo {
	label: string;
	resetsAt: number | null;
	usedFraction: number | null;
	remainingFraction: number | null;
	status: "ok" | "warning" | "exhausted" | "unknown";
}

interface ProviderLimits {
	provider: string;
	error: string | null;
	account: { email?: string; planType?: string; accountId?: string };
	resetCredits: number | null;
	limits: LimitInfo[];
}

interface LimitsData {
	fetchedAt: number;
	providers: ProviderLimits[];
}

async function fetchJson(url: string, headers: Record<string, string>) {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) throw new Error(`request failed (${response.status})`);
	return response.json();
}

function providerError(provider: string, error: unknown): ProviderLimits {
	return {
		provider,
		error: error instanceof Error ? error.message : String(error),
		account: {},
		resetCredits: null,
		limits: [],
	};
}

function parseResetAt(value): number | null {
	if (!value) return null;
	const reset = Date.parse(value);
	return Number.isNaN(reset) ? null : reset;
}

async function fetchOpenCodeLimits(): Promise<ProviderLimits> {
	const apiKey = process.env.OPENCODE_API_KEY;
	if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");
	const payload = await fetchJson(OPENCODE_URL, { Authorization: `Bearer ${apiKey}` });
	const descriptors = [
		["rolling", "5 Hour limit"],
		["weekly", "Weekly limit"],
		["monthly", "Monthly limit"],
	];
	const limits = descriptors.map(([key, label]) => {
		const window = payload.usage[key];
		const percent = window.percent;
		if (typeof percent !== "number" || percent < 0 || percent > 100) throw new Error("usage response window was malformed");
		const usedFraction = percent / 100;
		return {
			label,
			resetsAt: parseResetAt(window.resetsAt),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
			status: window.status === "rate-limited" || usedFraction >= 1 ? "exhausted" : usedFraction >= 0.8 ? "warning" : "ok",
		} as LimitInfo;
	});
	return {
		provider: "opencode-go",
		error: null,
		account: { planType: "OpenCode Go" },
		resetCredits: null,
		limits,
	};
}

function windowLabel(seconds: number): string {
	if (seconds >= 86_400) {
		const days = Math.round(seconds / 86_400);
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	const hours = Math.max(1, Math.round(seconds / 3_600));
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function codexResetAt(window, now: number): number | null {
	if (typeof window.reset_at === "number") return window.reset_at > 1_000_000_000_000 ? window.reset_at : window.reset_at * 1_000;
	if (typeof window.reset_after_seconds === "number") return now + window.reset_after_seconds * 1_000;
	return null;
}

function codexLimit(window, fallbackLabel: string, explicitlyAllowed: boolean, now: number, feature?: string): LimitInfo {
	const usedFraction = typeof window.used_percent === "number" ? Math.min(Math.max(window.used_percent, 0), 100) / 100 : null;
	const label = typeof window.limit_window_seconds === "number" ? windowLabel(window.limit_window_seconds) : fallbackLabel;
	const status = usedFraction === null
		? "unknown"
		: usedFraction >= 1
			? explicitlyAllowed ? "warning" : "exhausted"
			: usedFraction >= 0.9 ? "warning" : "ok";
	return {
		label: feature ? `${label} (${feature})` : label,
		resetsAt: codexResetAt(window, now),
		usedFraction,
		remainingFraction: usedFraction === null ? null : Math.max(0, 1 - usedFraction),
		status,
	};
}

function featureName(limit): string {
	const probe = `${limit.limit_name ?? ""} ${limit.metered_feature ?? ""}`.toLowerCase();
	if (probe.includes("spark") || probe.includes("bengalfox")) return "Spark";
	return limit.limit_name ?? limit.metered_feature ?? "Extra";
}

function appendCodexWindows(limits: LimitInfo[], rateLimit, now: number, feature?: string): void {
	if (!rateLimit) return;
	const explicitlyAllowed = rateLimit.allowed === true && rateLimit.limit_reached === false;
	if (rateLimit.primary_window) limits.push(codexLimit(rateLimit.primary_window, "Primary window", explicitlyAllowed, now, feature));
	if (rateLimit.secondary_window) limits.push(codexLimit(rateLimit.secondary_window, "Secondary window", explicitlyAllowed, now, feature));
}

async function fetchCodexLimits(ctx: ExtensionCommandContext, now: number): Promise<ProviderLimits> {
	const auth = await resolveCodexAuth(ctx);
	if (!auth) throw new Error("no openai-codex credentials; log in with /login");
	const headers = { Authorization: `Bearer ${auth.apiKey}` };
	if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
	const payload = await fetchJson(CODEX_URL, headers);
	const limits: LimitInfo[] = [];
	appendCodexWindows(limits, payload.rate_limit, now);
	for (const additional of payload.additional_rate_limits ?? []) {
		appendCodexWindows(limits, additional.rate_limit, now, featureName(additional));
	}
	if (limits.length === 0) throw new Error("usage response had no rate-limit windows");
	return {
		provider: "openai-codex",
		error: null,
		account: { email: auth.email, planType: payload.plan_type, accountId: auth.accountId },
		resetCredits: payload.rate_limit_reset_credits?.available_count ?? null,
		limits,
	};
}

async function fetchLimits(ctx: ExtensionCommandContext): Promise<LimitsData> {
	const fetchedAt = Date.now();
	const [codex, opencode] = await Promise.all([
		fetchCodexLimits(ctx, fetchedAt).catch((error) => providerError("openai-codex", error)),
		fetchOpenCodeLimits().catch((error) => providerError("opencode-go", error)),
	]);
	return { fetchedAt, providers: [codex, opencode] };
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (ms < minute) return `${Math.max(1, Math.round(ms / 1_000))}s`;
	if (ms < hour) {
		const minutes = Math.floor(ms / minute);
		const seconds = Math.floor((ms % minute) / 1_000);
		return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	}
	if (ms < day) {
		const hours = Math.floor(ms / hour);
		const minutes = Math.floor((ms % hour) / minute);
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	const days = Math.floor(ms / day);
	const hours = Math.floor((ms % day) / hour);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

function providerDisplayName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function accountLabel(provider: ProviderLimits): string {
	const { email, planType } = provider.account;
	if (email) return planType ? `${email} (${planType})` : email;
	if (provider.provider === "opencode-go") return "account 1";
	if (planType) return planType;
	if (provider.account.accountId) return provider.account.accountId.slice(0, 8);
	return "";
}

function statusColor(status: LimitInfo["status"]): "success" | "warning" | "error" | "dim" {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

function statusIcon(status: LimitInfo["status"]): string {
	if (status === "exhausted") return "✖";
	if (status === "warning") return "⚠";
	if (status === "ok") return "✓";
	return "·";
}

function formatRemaining(remaining: number | null): string {
	if (remaining === null) return "—% free";
	const percent = Math.max(0, remaining * 100);
	return `${percent >= 100 ? "100" : percent.toFixed(1)}% free`;
}

function resetSuffix(resetsAt: number | null): string {
	return resetsAt !== null && resetsAt > Date.now() ? `  (${formatDuration(resetsAt - Date.now())})` : "";
}

function renderLimitBar(fraction: number | null, width: number, color: "success" | "warning" | "error" | "dim", theme: Theme): string {
	if (fraction === null) return theme.fg("dim", "·".repeat(Math.max(width, 1)));
	const exact = Math.min(Math.max(fraction, 0), 1) * width;
	const fullCells = Math.floor(exact);
	const remainder = exact - fullCells;
	const partial = remainder >= 2 / 3 ? "▓" : remainder >= 1 / 3 ? "▒" : "";
	const filled = "█".repeat(fullCells) + partial;
	const empty = "░".repeat(Math.max(0, width - fullCells - (partial ? 1 : 0)));
	return theme.fg(color, filled) + theme.fg("dim", empty);
}

class StatusComponent {
	private data: LimitsData | null = null;
	private inFlight = false;
	private disposed = false;

	constructor(
		private theme: Theme,
		private requestRender: () => void,
		private done: () => void,
		private fetcher: () => Promise<LimitsData>
	) {
		this.fetch();
	}

	private fetch(): void {
		if (this.disposed || this.inFlight) return;
		this.inFlight = true;
		this.data = null;
		this.requestRender();
		this.fetcher()
			.then((data) => {
				if (this.disposed) return;
				this.data = data;
				this.requestRender();
			})
			.finally(() => {
				this.inFlight = false;
			});
	}

	handleInput(input: string): void {
		if (matchesKey(input, "escape") || matchesKey(input, "q")) this.done();
		else if (matchesKey(input, "r")) this.fetch();
	}

	render(width: number): string[] {
		const lines = [this.theme.fg("accent", this.theme.bold("Provider Status")), ""];
		if (!this.data) {
			lines.push(this.theme.fg("dim", "  Fetching provider status…"), "");
		} else {
			lines.push(this.theme.fg("muted", `Provider limits · fetched ${formatDuration(Date.now() - this.data.fetchedAt)} ago`), "");
			for (const provider of this.data.providers) this.renderProvider(lines, provider, width);
		}
		lines.push(this.theme.fg("dim", "[r] refresh  [q] close"));
		return lines.map((line) => truncateToWidth(line, Math.max(width, 0)));
	}

	private renderProvider(lines: string[], provider: ProviderLimits, width: number): void {
		lines.push(this.theme.bold(this.theme.fg("accent", providerDisplayName(provider.provider))));
		if (provider.error) {
			lines.push(`${this.theme.fg("warning", "⚠ ")} ${this.theme.fg("dim", provider.error)}`, "");
			return;
		}
		const account = accountLabel(provider);
		if (account) lines.push(`  ${this.theme.fg("dim", account)}`);
		let trailingWidth = 0;
		for (const limit of provider.limits) {
			trailingWidth = Math.max(trailingWidth, visibleWidth(`  ${formatRemaining(limit.remainingFraction)}${resetSuffix(limit.resetsAt)}`));
		}
		const barWidth = Math.min(Math.max(width - 24 - trailingWidth, 8), 44);
		for (const limit of provider.limits) {
			const color = statusColor(limit.status);
			const header = `${this.theme.fg(color, statusIcon(limit.status))} ${this.theme.bold(limit.label)}`;
			const bar = renderLimitBar(limit.usedFraction, barWidth, color, this.theme);
			lines.push(`${header}  ${bar}  ${formatRemaining(limit.remainingFraction)}${resetSuffix(limit.resetsAt)}`.trimEnd());
			if (limit.resetsAt !== null && limit.resetsAt > Date.now()) {
				lines.push(`  ${this.theme.fg("dim", `resets in ${formatDuration(limit.resetsAt - Date.now())}`)}`);
			}
		}
		if (provider.resetCredits !== null && provider.resetCredits > 0) {
			lines.push(`  ${this.theme.fg("dim", `✦ ${provider.resetCredits} saved reset${provider.resetCredits === 1 ? "" : "s"} available`)}`);
		}
		lines.push("");
	}

	invalidate(): void {}
	dispose(): void {
		this.disposed = true;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show provider quota status",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") return;
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const border = new Container();
				border.addChild(new Spacer(1));
				border.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));
				border.addChild(new Spacer(1));
				const status = new StatusComponent(theme, () => tui.requestRender(), () => done(), () => fetchLimits(ctx));
				return {
					render: (width: number) => {
						const lines = [...border.render(width), ...status.render(width), "", theme.fg("border", "─".repeat(width))];
						return lines.map((line) => truncateToWidth(line, width));
					},
					invalidate: () => border.invalidate(),
					handleInput: (input: string) => status.handleInput(input),
					dispose: () => status.dispose(),
				};
			});
		},
	});
}
