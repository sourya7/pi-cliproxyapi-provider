import { describe, expect, it } from "vitest";
import {
	findOpenCodeKey,
	formatReport,
	formatStatus,
	parseCodexSignals,
	parseCodexUsage,
	parseOpenCodeUsage,
	sessionTokensForModel,
	upstreamForModel,
	windowLabel,
} from "../extensions/usage.ts";

const codexBody = {
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1794261236 },
		secondary_window: { used_percent: 92, limit_window_seconds: 604800, reset_at: 1794635745 },
	},
	additional_rate_limits: null,
	model_usage: { "gpt-6-astra": { available: true, available_at: null } },
	credits: { has_credits: false, unlimited: false, balance: "0" },
};

describe("upstreamForModel", () => {
	it("maps proxy owners to quota sources", () => {
		expect(upstreamForModel("gpt-6.1-sol", "openai")).toBe("codex");
		expect(upstreamForModel("opencode-go/glm-5.3", "opencode-go")).toBe("opencode-go");
		expect(upstreamForModel("claude-opus-5-5", "anthropic")).toBeUndefined();
	});

	it("falls back to the model prefix when the owner is unknown", () => {
		expect(upstreamForModel("opencode-go/kimi-k3", undefined)).toBe("opencode-go");
		expect(upstreamForModel("gpt-6.1-sol", undefined)).toBeUndefined();
	});
});

describe("windowLabel", () => {
	it("names common windows", () => {
		expect(windowLabel(300, "x")).toBe("5h");
		expect(windowLabel(10080, "x")).toBe("wk");
		expect(windowLabel(2880, "x")).toBe("2d");
		expect(windowLabel(undefined, "primary")).toBe("primary");
	});
});

describe("parseCodexUsage", () => {
	it("normalizes account-wide windows", () => {
		const report = parseCodexUsage(codexBody, "gpt-6.1-sol", 1000);
		expect(report.windows).toEqual([
			{ label: "5h", usedPercent: 20, resetsAt: 1794261236 },
			{ label: "wk", usedPercent: 92, resetsAt: 1794635745 },
		]);
		expect(report.notes).toContain("Plan: plus");
		expect(formatStatus(report)).toBe("codex 80% 5h · 8% wk");
	});

	it("prefers a limit that matches the current model", () => {
		const report = parseCodexUsage(
			{
				...codexBody,
				additional_rate_limits: [
					{
						limit_name: "GPT-6.1-Sol-Spark",
						metered_feature: "gpt-6.1-sol-spark",
						rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } },
					},
				],
			},
			"gpt-6.1-sol-spark",
			1000,
		);
		expect(report.windows).toEqual([{ label: "5h", usedPercent: 5 }]);
	});

	it("reports models that are currently unavailable", () => {
		const report = parseCodexUsage(
			{ ...codexBody, model_usage: { "gpt-6-astra": { available: false, available_at: null } } },
			"gpt-6-astra",
			1000,
		);
		expect(report.notes).toContain("Model currently unavailable");
	});

	it("rejects responses without windows", () => {
		expect(() => parseCodexUsage({ rate_limit: null }, "gpt-6.1-sol", 1000)).toThrow();
	});
});

describe("parseCodexSignals", () => {
	it("reads the proxy's recorded X-Codex headers case-insensitively", () => {
		const report = parseCodexSignals({
			observed_at: "2026-11-09T12:14:47.617898545-07:00",
			signals: {
				"X-Codex-Plan-Type": "plus",
				"X-Codex-Primary-Used-Percent": "20",
				"X-Codex-Primary-Reset-At": "1794261236",
				"X-Codex-Primary-Window-Minutes": "300",
				"X-Codex-Secondary-Used-Percent": "92",
				"X-Codex-Secondary-Window-Minutes": "10080",
			},
		});
		expect(report?.source).toBe("passive");
		expect(report?.observedAt).toBe(Date.parse("2026-11-09T19:14:47.617Z"));
		expect(report && formatStatus(report)).toBe("codex 80% 5h · 8% wk");
	});

	it("returns undefined without signals", () => {
		expect(parseCodexSignals({ signals: {} })).toBeUndefined();
		expect(parseCodexSignals(undefined)).toBeUndefined();
	});
});

describe("parseOpenCodeUsage", () => {
	it("normalizes rolling, weekly and monthly windows", () => {
		const report = parseOpenCodeUsage(
			{
				usage: {
					rolling: { status: "ok", percent: 0, resetsAt: "2026-11-09T23:12:08.000Z" },
					weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-16T00:00:00.000Z" },
					monthly: { status: "ok", percent: 32, resetsAt: "2026-11-23T22:17:45.000Z" },
				},
			},
			1000,
		);
		expect(formatStatus(report)).toBe("go 100% roll · 0% wk · 68% mo");
		expect(report.windows[0]?.resetsAt).toBe(Date.parse("2026-11-09T23:12:08.000Z") / 1000);
		expect(report.notes).toEqual(["weekly window is rate-limited"]);
	});

	it("notes unknown statuses and rejects empty usage", () => {
		const report = parseOpenCodeUsage(
			{ usage: { rolling: { status: "ok", percent: 10 }, weekly: { status: "weird" } } },
			1000,
		);
		expect(report.notes).toEqual(["weekly window unavailable (weird)"]);
		expect(() => parseOpenCodeUsage({ usage: {} }, 1000)).toThrow();
	});
});

describe("findOpenCodeKey", () => {
	const config = (keys: unknown[], extra: Record<string, unknown> = {}) => ({
		plugins: {
			configs: {
				"opencode-go-cliproxyapi": {
					enabled: true,
					"model-prefix": { enabled: true, value: "opencode-go" },
					"api-keys": keys,
				},
				...extra,
			},
		},
	});

	it("returns the single key of the plugin matching the model prefix", () => {
		expect(findOpenCodeKey(config([{ value: "sk-test" }]), "opencode-go/glm-5.3")).toBe("sk-test");
	});

	it("ignores plugins with other prefixes", () => {
		const other = { other: { "model-prefix": { value: "other" }, "api-keys": [{ value: "x" }] } };
		expect(findOpenCodeKey(config([{ value: "sk-test" }], other), "opencode-go/glm-5.3")).toBe("sk-test");
	});

	it("rejects ambiguous, missing and env-expanded keys", () => {
		expect(() => findOpenCodeKey(config([{ value: "a" }, { value: "b" }]), "opencode-go/x")).toThrow(/found 2/);
		expect(() => findOpenCodeKey(config([]), "opencode-go/x")).toThrow(/found 0/);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: CLIProxyAPI's literal env placeholder syntax.
		expect(() => findOpenCodeKey(config([{ value: "${OPENCODE_KEY}" }]), "opencode-go/x")).toThrow(/ENV/);
		expect(() => findOpenCodeKey({}, "opencode-go/x")).toThrow(/plugin/);
	});
});

describe("session tokens and report", () => {
	const assistant = (model: string, input: number, output: number) => ({
		type: "message",
		message: {
			role: "assistant",
			provider: "cliproxyapi",
			model,
			usage: { input, output, cacheRead: 1, cacheWrite: 0, totalTokens: input + output, cost: { total: 0 } },
		},
	});

	it("sums only the current model's assistant turns", () => {
		const entries = [
			assistant("gpt-6.1-sol", 100, 10),
			{ type: "message", message: { role: "user", content: "hi" } },
			assistant("opencode-go/glm-5.3", 999, 999),
			assistant("gpt-6.1-sol", 50, 5),
		];
		expect(sessionTokensForModel(entries, "cliproxyapi", "gpt-6.1-sol")).toMatchObject({
			turns: 2,
			input: 150,
			output: 15,
			cacheRead: 2,
		});
	});

	it("formats a report with resets and session totals", () => {
		const now = 1794261236 * 1000 - 3600 * 1000;
		const report = parseCodexUsage(codexBody, "gpt-6.1-sol", now);
		const text = formatReport(report, "gpt-6.1-sol", sessionTokensForModel([], "cliproxyapi", "gpt-6.1-sol"), now);
		expect(text).toContain("Codex usage for gpt-6.1-sol (account-wide, live, just now)");
		expect(text).toContain("5h     20% used, 80% left, resets in 1h0m");
		expect(text).toContain("Session on this model: 0 turns");
	});
});
