/**
 * Upstream plan usage for the current CLIProxyAPI model.
 *
 * Reads quota through the CLIProxyAPI v8 management API, so provider
 * credentials stay on the proxy:
 * - Codex: live `wham/usage` via `/requests/api-call` with `$TOKEN$`, plus the
 *   passive `X-Codex-*` signals the proxy records on every request.
 * - OpenCode Go: the plugin's API key from `/config`, forwarded by the proxy to
 *   `https://opencode.ai/zen/go/v1/usage`.
 * - Claude: the `Anthropic-Ratelimit-Unified-*` signals the proxy records on
 *   every Claude request. There is no live source, so data ages between requests.
 *
 * Requires CLIPROXYAPI_MANAGEMENT_KEY. Without it the extension stays inactive.
 * Reported windows are account-wide allowances, not this session's consumption;
 * `/usage` shows session tokens separately.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveConnection, resolveEndpoints, resolveIdentity } from "./lib.ts";

export const MANAGEMENT_KEY_ENV = "CLIPROXYAPI_MANAGEMENT_KEY";
// PiChat routes this conventional key into its header rather than the transcript.
const STATUS_KEY = "usage";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum age before an event-driven refresh makes another upstream call. */
const LIVE_MIN_AGE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export type Upstream = "codex" | "opencode-go" | "claude";

export interface UsageWindow {
	label: string;
	usedPercent: number;
	/** Unix seconds. */
	resetsAt?: number;
}

export interface UsageReport {
	upstream: Upstream;
	windows: UsageWindow[];
	notes: string[];
	/** Epoch milliseconds when the data was observed. */
	observedAt: number;
	source: "live" | "passive";
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Short label for a window length in minutes: 300 -> "5h", 10080 -> "wk". */
export function windowLabel(minutes: number | undefined, fallback: string): string {
	if (minutes === undefined || minutes <= 0) return fallback;
	if (minutes === 10080) return "wk";
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** Map a CLIProxyAPI model to the upstream whose quota it consumes. */
export function upstreamForModel(modelId: string, ownedBy: string | undefined): Upstream | undefined {
	const owner = ownedBy?.toLowerCase();
	if (owner === "opencode-go" || (!owner && modelId.toLowerCase().startsWith("opencode-go/"))) return "opencode-go";
	if (owner === "openai") return "codex";
	if (owner === "anthropic") return "claude";
	return undefined;
}

function codexWindows(rateLimit: unknown): UsageWindow[] {
	const limit = asObject(rateLimit);
	if (!limit) return [];
	const windows: UsageWindow[] = [];
	for (const [key, fallback] of [
		["primary_window", "primary"],
		["secondary_window", "secondary"],
	] as const) {
		const window = asObject(limit[key]);
		const used = asNumber(window?.used_percent);
		if (!window || used === undefined) continue;
		const seconds = asNumber(window.limit_window_seconds);
		const resetsAt = asNumber(window.reset_at);
		windows.push({
			label: windowLabel(seconds === undefined ? undefined : Math.round(seconds / 60), fallback),
			usedPercent: used,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}
	return windows;
}

function modelKeyMatches(modelId: string, ...keys: Array<string | undefined>): boolean {
	const model = modelId.toLowerCase();
	return keys.some((key) => {
		const k = key?.toLowerCase();
		return !!k && (model === k || model.includes(k) || k.includes(model));
	});
}

/** Normalize a live `wham/usage` body, preferring a model-specific limit when one matches. */
export function parseCodexUsage(body: unknown, modelId: string, observedAt: number): UsageReport {
	const payload = asObject(body);
	if (!payload) throw new Error("Codex usage response was not an object");

	let windows = codexWindows(payload.rate_limit);
	const notes: string[] = [];
	const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
	for (const item of additional) {
		const entry = asObject(item);
		const name = asString(entry?.limit_name);
		if (!entry || !modelKeyMatches(modelId, name, asString(entry.metered_feature))) continue;
		const specific = codexWindows(entry.rate_limit);
		if (specific.length > 0) {
			windows = specific;
			notes.push(`Model-specific limit: ${name ?? asString(entry.metered_feature)}`);
		}
		break;
	}
	if (windows.length === 0) throw new Error("Codex usage response had no rate-limit windows");

	const modelUsage = asObject(asObject(payload.model_usage)?.[modelId]);
	if (modelUsage?.available === false) {
		const at = asNumber(modelUsage.available_at);
		notes.push(
			at ? `Model unavailable until ${new Date(at * 1000).toLocaleString()}` : "Model currently unavailable",
		);
	}
	const plan = asString(payload.plan_type);
	if (plan) notes.push(`Plan: ${plan}`);
	const credits = asObject(payload.credits);
	if (credits?.has_credits === true)
		notes.push(`Credits: ${credits.unlimited === true ? "unlimited" : (asString(credits.balance) ?? "available")}`);

	return { upstream: "codex", windows, notes, observedAt, source: "live" };
}

/**
 * Normalize the `X-Codex-*` headers CLIProxyAPI records on the Codex credential.
 * These are account-wide; per-model copies are only refreshed when that model is
 * used, so they can be older than the account-wide entry.
 */
export function parseCodexSignals(quota: unknown): UsageReport | undefined {
	const observation = asObject(quota);
	const raw = asObject(observation?.signals);
	if (!raw) return undefined;
	const signals = new Map<string, string>();
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") signals.set(key.toLowerCase(), value);
	}
	const windows: UsageWindow[] = [];
	for (const position of ["primary", "secondary"]) {
		const used = asNumber(signals.get(`x-codex-${position}-used-percent`));
		if (used === undefined) continue;
		const resetsAt = asNumber(signals.get(`x-codex-${position}-reset-at`));
		windows.push({
			label: windowLabel(asNumber(signals.get(`x-codex-${position}-window-minutes`)), position),
			usedPercent: used,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}
	if (windows.length === 0) return undefined;
	const observedAt = Date.parse(asString(observation?.observed_at) ?? "");
	const plan = signals.get("x-codex-plan-type");
	return {
		upstream: "codex",
		windows,
		notes: plan ? [`Plan: ${plan}`] : [],
		observedAt: Number.isNaN(observedAt) ? Date.now() : observedAt,
		source: "passive",
	};
}

const CLAUDE_WINDOWS = [
	["5h", "5h"],
	["7d", "wk"],
] as const;

/**
 * Normalize the `Anthropic-Ratelimit-Unified-*` headers CLIProxyAPI records on
 * the Claude credential. Utilization is a 0-1 fraction; resets are Unix seconds.
 */
export function parseClaudeSignals(quota: unknown): UsageReport | undefined {
	const observation = asObject(quota);
	const raw = asObject(observation?.signals);
	if (!raw) return undefined;
	const signals = new Map<string, string>();
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") signals.set(key.toLowerCase(), value);
	}
	const prefix = "anthropic-ratelimit-unified-";
	const windows: UsageWindow[] = [];
	const notes: string[] = [];
	for (const [key, label] of CLAUDE_WINDOWS) {
		const utilization = asNumber(signals.get(`${prefix}${key}-utilization`));
		if (utilization === undefined) continue;
		const resetsAt = asNumber(signals.get(`${prefix}${key}-reset`));
		windows.push({
			label,
			usedPercent: utilization * 100,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
		const status = signals.get(`${prefix}${key}-status`);
		if (status && status !== "allowed") notes.push(`${label} window status: ${status}`);
	}
	if (windows.length === 0) return undefined;
	const overage = signals.get(`${prefix}overage-status`);
	// Overage is normally disabled; only mention it when it can actually apply.
	if (overage && overage !== "rejected") notes.push(`Overage: ${overage}`);
	const observedAt = Date.parse(asString(observation?.observed_at) ?? "");
	return {
		upstream: "claude",
		windows,
		notes,
		observedAt: Number.isNaN(observedAt) ? Date.now() : observedAt,
		source: "passive",
	};
}

const OPENCODE_WINDOWS = [
	["rolling", "roll"],
	["weekly", "wk"],
	["monthly", "mo"],
] as const;

/** Normalize the OpenCode Go (Zen) usage body. */
export function parseOpenCodeUsage(body: unknown, observedAt: number): UsageReport {
	const usage = asObject(asObject(body)?.usage);
	if (!usage) throw new Error("OpenCode Go usage response had no usage object");
	const windows: UsageWindow[] = [];
	const notes: string[] = [];
	for (const [key, label] of OPENCODE_WINDOWS) {
		const window = asObject(usage[key]);
		if (!window) continue;
		const status = asString(window.status);
		if (status !== "ok" && status !== "rate-limited") {
			notes.push(`${key} window unavailable (${status ?? "unknown status"})`);
			continue;
		}
		const used = asNumber(window.percent);
		if (used === undefined) continue;
		const resetsMs = Date.parse(asString(window.resetsAt) ?? "");
		windows.push({
			label,
			usedPercent: used,
			...(Number.isNaN(resetsMs) ? {} : { resetsAt: Math.floor(resetsMs / 1000) }),
		});
		if (status === "rate-limited") notes.push(`${key} window is rate-limited`);
	}
	if (windows.length === 0) throw new Error("OpenCode Go usage response had no usable windows");
	return { upstream: "opencode-go", windows, notes, observedAt, source: "live" };
}

/**
 * Find the single OpenCode Go API key in the proxy's plugin configuration.
 * Matches the plugin whose model prefix equals the model's prefix.
 */
export function findOpenCodeKey(config: unknown, modelId: string): string {
	const prefix = modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : "opencode-go";
	const configs = asObject(asObject(asObject(config)?.plugins)?.configs) ?? {};
	const matches = Object.entries(configs).filter(([id, value]) => {
		const plugin = asObject(value);
		if (!plugin || plugin.enabled === false) return false;
		const modelPrefix = asObject(plugin["model-prefix"]);
		const prefixValue = modelPrefix?.enabled === false ? undefined : asString(modelPrefix?.value);
		return prefixValue ? prefixValue === prefix : id.startsWith("opencode-go");
	});
	if (matches.length !== 1)
		throw new Error(`Expected one OpenCode Go plugin for "${prefix}", found ${matches.length}`);
	const keys = (
		Array.isArray(asObject(matches[0]![1])?.["api-keys"]) ? (asObject(matches[0]![1])!["api-keys"] as unknown[]) : []
	)
		.map((entry) => asString(asObject(entry)?.value) ?? asString(entry))
		.filter((key): key is string => !!key);
	if (keys.length !== 1) throw new Error(`Expected one OpenCode Go API key, found ${keys.length}`);
	if (keys[0]!.includes("${"))
		throw new Error("OpenCode Go API key uses $ENV expansion on the proxy; it cannot be resolved");
	return keys[0]!;
}

const UPSTREAM_LABEL: Record<Upstream, string> = { codex: "codex", "opencode-go": "go", claude: "claude" };
const UPSTREAM_NAME: Record<Upstream, string> = { codex: "Codex", "opencode-go": "OpenCode Go", claude: "Claude" };

/** Compact status: remaining percentage per window, e.g. `codex 80% 5h · 8% wk`. */
export function formatStatus(report: UsageReport): string {
	const windows = report.windows.map((w) => `${Math.round(Math.max(0, 100 - w.usedPercent))}% ${w.label}`);
	return `${UPSTREAM_LABEL[report.upstream]} ${windows.join(" · ")}`;
}

export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

export interface SessionTokens {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Sum assistant usage on the current branch for one provider/model. */
export function sessionTokensForModel(entries: readonly unknown[], provider: string, modelId: string): SessionTokens {
	const totals: SessionTokens = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		const e = asObject(entry);
		if (e?.type !== "message") continue;
		const message = asObject(e.message) as Partial<AssistantMessage> | undefined;
		if (message?.role !== "assistant" || message.provider !== provider || message.model !== modelId || !message.usage)
			continue;
		totals.turns += 1;
		totals.input += message.usage.input || 0;
		totals.output += message.usage.output || 0;
		totals.cacheRead += message.usage.cacheRead || 0;
		totals.cacheWrite += message.usage.cacheWrite || 0;
		totals.cost += message.usage.cost?.total || 0;
	}
	return totals;
}

export function formatReport(report: UsageReport, modelId: string, tokens: SessionTokens, now = Date.now()): string {
	const name = UPSTREAM_NAME[report.upstream];
	const age = Math.round((now - report.observedAt) / 1000);
	const lines = [
		`${name} usage for ${modelId} (account-wide, ${report.source === "live" ? "live" : "last request"}, ${age < 60 ? "just now" : `${formatDuration(age)} ago`})`,
	];
	for (const w of report.windows) {
		const reset = w.resetsAt === undefined ? "" : `, resets in ${formatDuration(w.resetsAt - now / 1000)}`;
		lines.push(
			`  ${w.label.padEnd(5)} ${w.usedPercent.toFixed(0).padStart(3)}% used, ${Math.max(0, 100 - w.usedPercent).toFixed(0)}% left${reset}`,
		);
	}
	for (const note of report.notes) lines.push(`  ${note}`);
	lines.push(
		`Session on this model: ${tokens.turns} turns, in ${tokens.input.toLocaleString()}, out ${tokens.output.toLocaleString()}, cache r/w ${tokens.cacheRead.toLocaleString()}/${tokens.cacheWrite.toLocaleString()}`,
	);
	return lines.join("\n");
}

class ManagementClient {
	constructor(
		private readonly base: string,
		private readonly key: string,
	) {}

	async request(path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${this.base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${this.key}`,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		// Never surface response bodies: they can contain account data.
		if (!response.ok) throw new Error(`CLIProxyAPI management ${path} failed (HTTP ${response.status})`);
		return response.json();
	}

	/** Have the proxy perform an upstream request; returns the parsed upstream body. */
	async apiCall(request: { auth_index?: string; url: string; header: Record<string, string> }): Promise<unknown> {
		const result = asObject(await this.request("/requests/api-call", { method: "GET", ...request }));
		const status = asNumber(result?.status_code);
		if (status === undefined || status < 200 || status > 299) {
			throw new Error(`Upstream usage request failed (HTTP ${status ?? "unavailable"})`);
		}
		const body = result?.body;
		return typeof body === "string" ? JSON.parse(body) : body;
	}
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const { providerId } = resolveIdentity(agentDir);

	let client: ManagementClient | undefined;
	let rootOrigin: string | undefined;
	let inferenceKey: string | undefined;
	let ownedBy: Map<string, string> | undefined;
	let openCodeKey: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let statusCtx: ExtensionContext | undefined;
	let generation = 0;
	const reports = new Map<Upstream, UsageReport>();
	const inflight = new Map<string, Promise<UsageReport>>();

	function setup(): boolean {
		const key = process.env[MANAGEMENT_KEY_ENV]?.trim();
		if (!key) return false;
		const connection = resolveConnection(agentDir, providerId);
		if (!connection) return false;
		rootOrigin = resolveEndpoints(connection.baseUrlInput).rootOrigin;
		inferenceKey = connection.apiKey;
		client = new ManagementClient(`${rootOrigin}/v8/management`, key);
		return true;
	}

	async function ownerOf(modelId: string): Promise<string | undefined> {
		if (!ownedBy?.has(modelId) && rootOrigin && inferenceKey) {
			const response = await fetch(`${rootOrigin}/v1/models`, {
				headers: { Authorization: `Bearer ${inferenceKey}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (response.ok) {
				const data = asObject(await response.json())?.data;
				ownedBy = new Map();
				for (const item of Array.isArray(data) ? data : []) {
					const model = asObject(item);
					const id = asString(model?.id);
					const owner = asString(model?.owned_by);
					if (id && owner) ownedBy.set(id, owner);
				}
			}
		}
		return ownedBy?.get(modelId);
	}

	async function upstreamOf(ctx: ExtensionContext): Promise<Upstream | undefined> {
		const model = ctx.model;
		if (!model || model.provider !== providerId) return undefined;
		return upstreamForModel(model.id, await ownerOf(model.id));
	}

	async function credential(provider: "codex" | "claude"): Promise<Json> {
		const files = asObject(await client!.request("/credentials"))?.files;
		const accounts = (Array.isArray(files) ? files : [])
			.map(asObject)
			.filter((f): f is Json => !!f && (f.provider === provider || f.type === provider) && f.disabled !== true);
		if (accounts.length !== 1) {
			throw new Error(`Expected one enabled ${UPSTREAM_NAME[provider]} account, found ${accounts.length}`);
		}
		return accounts[0]!;
	}

	async function claudeReport(): Promise<UsageReport> {
		const report = parseClaudeSignals((await credential("claude")).quota);
		if (!report) throw new Error("No Claude usage recorded yet; it appears after a Claude request");
		return report;
	}

	async function fetchLive(upstream: Upstream, modelId: string): Promise<UsageReport> {
		// Claude has no live usage source; the proxy's recorded signals are the best data.
		if (upstream === "claude") return claudeReport();
		if (upstream === "codex") {
			const account = await credential("codex");
			const authIndex = asString(account.auth_index);
			if (!authIndex) throw new Error("Codex account has no auth_index");
			const header: Record<string, string> = {
				Authorization: "Bearer $TOKEN$",
				Accept: "application/json",
				"User-Agent": "codex-tui",
			};
			const accountId =
				asString(account.chatgpt_account_id) ?? asString(asObject(account.id_token)?.chatgpt_account_id);
			if (accountId) header["Chatgpt-Account-Id"] = accountId;
			return parseCodexUsage(
				await client!.apiCall({ auth_index: authIndex, url: CODEX_USAGE_URL, header }),
				modelId,
				Date.now(),
			);
		}
		const call = async () =>
			client!.apiCall({
				url: OPENCODE_GO_USAGE_URL,
				header: { Authorization: `Bearer ${openCodeKey}`, Accept: "application/json" },
			});
		openCodeKey ??= findOpenCodeKey(await client!.request("/config"), modelId);
		try {
			return parseOpenCodeUsage(await call(), Date.now());
		} catch {
			// The key may have been rotated on the proxy; re-read it once.
			openCodeKey = findOpenCodeKey(await client!.request("/config"), modelId);
			return parseOpenCodeUsage(await call(), Date.now());
		}
	}

	async function fetchPassive(upstream: Upstream, modelId: string): Promise<UsageReport> {
		if (upstream === "claude") return claudeReport();
		if (upstream !== "codex") return fetchLive(upstream, modelId);
		const report = parseCodexSignals((await credential("codex")).quota);
		return report ?? fetchLive(upstream, modelId);
	}

	function render(ctx: ExtensionContext, upstream: Upstream | undefined): void {
		if (!ctx.hasUI) return;
		const report = upstream ? reports.get(upstream) : undefined;
		if (!report) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const text = formatStatus(report);
		ctx.ui.setStatus(STATUS_KEY, ctx.mode === "tui" ? ctx.ui.theme.fg("dim", text) : text);
	}

	async function refresh(
		ctx: ExtensionContext,
		mode: "live" | "passive" | "if-stale",
	): Promise<UsageReport | undefined> {
		if (!client || !ctx.model) return undefined;
		const current = ++generation;
		const modelId = ctx.model.id;
		const upstream = await upstreamOf(ctx);
		if (current !== generation) return undefined;
		if (!upstream) {
			render(ctx, undefined);
			return undefined;
		}
		const cached = reports.get(upstream);
		const effective =
			mode === "if-stale" ? (cached && Date.now() - cached.observedAt < LIVE_MIN_AGE_MS ? undefined : "live") : mode;
		if (!effective) {
			render(ctx, upstream);
			return cached;
		}
		const key = `${upstream}:${effective}`;
		let pending = inflight.get(key);
		if (!pending) {
			pending = (effective === "live" ? fetchLive : fetchPassive)(upstream, modelId).finally(() =>
				inflight.delete(key),
			);
			inflight.set(key, pending);
		}
		const report = await pending;
		// Passive data never replaces a newer live observation.
		const existing = reports.get(upstream);
		if (!existing || report.observedAt >= existing.observedAt) reports.set(upstream, report);
		if (current === generation) render(ctx, upstream);
		return reports.get(upstream);
	}

	function background(ctx: ExtensionContext, mode: "live" | "passive" | "if-stale"): void {
		refresh(ctx, mode).catch(() => {
			// Background refreshes keep the last good status; /usage reports errors.
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !setup()) return;
		statusCtx = ctx;
		background(ctx, "if-stale");
		timer = setInterval(() => {
			if (statusCtx) background(statusCtx, "live");
		}, REFRESH_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		if (!client || !ctx.hasUI) return;
		statusCtx = ctx;
		background(ctx, "if-stale");
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!client || !ctx.hasUI) return;
		statusCtx = ctx;
		// Codex: free proxy-side signals from the requests just made. OpenCode Go has none.
		background(ctx, "passive");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		generation++;
		if (client && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		client = undefined;
		openCodeKey = undefined;
		statusCtx = undefined;
		reports.clear();
	});

	pi.registerCommand("usage", {
		description: "Show upstream plan usage for the current CLIProxyAPI model",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /usage", "error");
				return;
			}
			if (!client && !setup()) {
				ctx.ui.notify(`/usage needs ${MANAGEMENT_KEY_ENV} and a configured CLIProxyAPI connection`, "error");
				return;
			}
			const model = ctx.model;
			if (!model || model.provider !== providerId) {
				ctx.ui.notify(`/usage only supports ${providerId} models`, "warning");
				return;
			}
			try {
				const report = await refresh(ctx, "live");
				if (!report) {
					ctx.ui.notify(
						`No supported usage source for ${model.id} (Codex, OpenCode Go and Claude only)`,
						"warning",
					);
					return;
				}
				const tokens = sessionTokensForModel(ctx.sessionManager.getBranch(), model.provider, model.id);
				ctx.ui.notify(formatReport(report, model.id, tokens), "info");
			} catch (error) {
				ctx.ui.notify(`Usage unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
