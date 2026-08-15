// Shared types for the /usage extension.
//
// Adapted from @tmustier/pi-usage-extension (MIT,
// https://github.com/tmustier/pi-extensions): the data shapes it defined are
// kept so the graph/table/insights UI ports stay faithful. The backend
// (src/usage.zig) produces these shapes as JSON; the glue converts the
// wire format into the Map-based structures below.

export interface TokenStats {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface BaseStats {
	messages: number;
	cost: number;
	tokens: TokenStats;
}

export interface ModelStats extends BaseStats {
	sessions: number;
}

export interface ProviderStats extends BaseStats {
	sessions: number;
	models: Map<string, ModelStats>;
}

export interface TotalStats extends BaseStats {
	sessions: number;
}

export interface Insight {
	kind: "structure" | "alarm";
	stat: string;
	headline: string;
	advice: string;
}

export interface PeriodData {
	providers: Map<string, ProviderStats>;
	totals: TotalStats;
	insights: { insights: Insight[] };
}

export interface HourlyCell {
	messages: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

export interface PeriodBounds {
	todayMs: number;
	weekStartMs: number;
	lastWeekStartMs: number;
	last30DaysStartMs: number;
	nowMs: number;
}

export type TabName = "today" | "thisWeek" | "lastWeek" | "last30Days" | "allTime";

export const TAB_ORDER: TabName[] = ["today", "thisWeek", "lastWeek", "last30Days", "allTime"];

export const HOURLY_KEY_SEP = "\u0000";

export function splitHourlyKey(key: string): { provider: string; model: string; thinkingLevel: string } {
	const [provider = "", model = "", thinkingLevel = ""] = key.split(HOURLY_KEY_SEP);
	return { provider, model, thinkingLevel };
}

export interface UsageData {
	today: PeriodData;
	thisWeek: PeriodData;
	lastWeek: PeriodData;
	last30Days: PeriodData;
	allTime: PeriodData;
	/** Deduped usage bucketed by hour start (ms) → series key → metrics. */
	hourly: Map<number, Map<string, HourlyCell>>;
	bounds: PeriodBounds;
}

// =============================================================================
// Backend wire format (src/usage.zig)
// =============================================================================

export interface BackendStats {
	messages: number;
	cost: number;
	sessions: number;
	tokens: TokenStats;
}

export interface BackendProvider extends BackendStats {
	models: Record<string, BackendStats>;
}

export interface BackendPeriod {
	providers: Record<string, BackendProvider>;
	totals: TotalStats;
	insights: { insights: Insight[] };
}

export interface BackendData {
	bounds: PeriodBounds;
	/** hourMs → "provider\u0000model\u0000level" → [messages, cost, input, output, cacheRead, cacheWrite, reasoning] */
	hourly: Record<string, Record<string, [number, number, number, number, number, number, number]>>;
	today: BackendPeriod;
	thisWeek: BackendPeriod;
	lastWeek: BackendPeriod;
	last30Days: BackendPeriod;
	allTime: BackendPeriod;
	/** Scan warnings (files that could not be stat/read/parsed; cached rows kept). */
	warnings?: string[];
}

export interface LimitInfo {
	id: string;
	label: string;
	windowId: string;
	windowLabel: string;
	durationMs: number | null;
	resetsAt: number | null;
	used: number | null;
	usedFraction: number | null;
	remainingFraction: number | null;
	status: "ok" | "warning" | "exhausted" | "unknown";
}

export interface ProviderLimits {
	provider: string;
	error: string | null;
	account: { email?: string; planType?: string; accountId?: string };
	resetCredits: number | null;
	limits: LimitInfo[];
}

export interface LimitsData {
	fetchedAt: number;
	providers: ProviderLimits[];
}

/** Convert the backend's JSON payload into the Map-based structures the UI uses. */
export function convertBackendData(raw: BackendData): UsageData {
	const period = (p: BackendPeriod): PeriodData => ({
		providers: new Map(
			Object.entries(p.providers).map(([name, provider]) => [
				name,
				{
					messages: provider.messages,
					cost: provider.cost,
					sessions: provider.sessions,
					tokens: provider.tokens,
					models: new Map(Object.entries(provider.models).map(([m, stats]) => [m, { ...stats }])),
				},
			])
		),
		totals: p.totals,
		insights: p.insights,
	});
	return {
		today: period(raw.today),
		thisWeek: period(raw.thisWeek),
		lastWeek: period(raw.lastWeek),
		last30Days: period(raw.last30Days),
		allTime: period(raw.allTime),
		hourly: new Map(
			Object.entries(raw.hourly).map(([hour, cells]) => [
				Number(hour),
				new Map(
					Object.entries(cells).map(([key, a]) => [
						key,
						{
							messages: a[0],
							cost: a[1],
							input: a[2],
							output: a[3],
							cacheRead: a[4],
							cacheWrite: a[5],
							reasoning: a[6],
						},
					])
				),
			])
		),
		bounds: raw.bounds,
	};
}
