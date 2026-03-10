import { describe, expect, test, beforeEach } from "bun:test";
import {
	containsRateLimitSignal,
	getDowngradeModel,
	getCheapestModel,
	initUsageWatcher,
	recordLlmInteraction,
	getUsageWatcherStatus,
	resetUsageWatcher,
	wrapProviderWithWatcher,
	writeRestartBreadcrumb,
	consumeRestartBreadcrumb,
} from "./usage-watcher";
import type { LlmProvider } from "@signet/core";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("containsRateLimitSignal", () => {
	test("detects rate limit exceeded", () => {
		expect(containsRateLimitSignal("Error: rate limit exceeded")).toBe(true);
	});

	test("detects weekly usage limit warnings", () => {
		expect(containsRateLimitSignal("You're nearing your weekly usage limit")).toBe(true);
	});

	test("detects session limit warnings", () => {
		expect(containsRateLimitSignal("You're nearing your session limit")).toBe(true);
	});

	test("detects too many requests", () => {
		expect(containsRateLimitSignal("Too many requests, please slow down")).toBe(true);
	});

	test("detects budget cap", () => {
		expect(containsRateLimitSignal("budget cap exceeded")).toBe(true);
	});

	test("detects 429 status", () => {
		expect(containsRateLimitSignal("HTTP 429 response")).toBe(true);
	});

	test("detects throttling", () => {
		expect(containsRateLimitSignal("Request throttled")).toBe(true);
	});

	test("returns false for normal text", () => {
		expect(containsRateLimitSignal("Here is your extraction result")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(containsRateLimitSignal("")).toBe(false);
	});
});

describe("getDowngradeModel", () => {
	test("downgrades claude-code opus to sonnet", () => {
		expect(getDowngradeModel("claude-code", "opus")).toBe("sonnet");
	});

	test("downgrades claude-code sonnet to haiku", () => {
		expect(getDowngradeModel("claude-code", "sonnet")).toBe("haiku");
	});

	test("returns null when already at cheapest", () => {
		expect(getDowngradeModel("claude-code", "haiku")).toBeNull();
	});

	test("downgrades codex to mini", () => {
		expect(getDowngradeModel("codex", "gpt-5.3-codex")).toBe("gpt-5-codex");
		expect(getDowngradeModel("codex", "gpt-5-codex")).toBe("gpt-5-codex-mini");
	});

	test("unknown model jumps to cheapest", () => {
		expect(getDowngradeModel("claude-code", "unknown-model")).toBe("haiku");
	});

	test("unknown provider returns null", () => {
		expect(getDowngradeModel("unknown-provider", "model")).toBeNull();
	});
});

describe("getCheapestModel", () => {
	test("returns haiku for claude-code", () => {
		expect(getCheapestModel("claude-code")).toBe("haiku");
	});

	test("returns mini for codex", () => {
		expect(getCheapestModel("codex")).toBe("gpt-5-codex-mini");
	});

	test("returns null for unknown provider", () => {
		expect(getCheapestModel("unknown")).toBeNull();
	});
});

describe("usage watcher lifecycle", () => {
	beforeEach(() => {
		initUsageWatcher(
			{
				enabled: true,
				checkIntervalMs: 0,
				triggerThreshold: 2,
				cooldownMs: 1000,
				restartOnDowngrade: false,
			},
			"claude-code",
			"opus",
		);
	});

	test("initializes with correct state", () => {
		const status = getUsageWatcherStatus();
		expect(status.enabled).toBe(true);
		expect(status.state?.currentProvider).toBe("claude-code");
		expect(status.state?.currentModel).toBe("opus");
		expect(status.state?.consecutiveSignals).toBe(0);
	});

	test("does not trigger on normal responses", () => {
		const result = recordLlmInteraction("Normal extraction result");
		expect(result).toBeNull();
		expect(getUsageWatcherStatus().state?.consecutiveSignals).toBe(0);
	});

	test("counts consecutive signals", () => {
		recordLlmInteraction("", "rate limit exceeded");
		expect(getUsageWatcherStatus().state?.consecutiveSignals).toBe(1);
	});

	test("resets counter on successful response", () => {
		recordLlmInteraction("", "rate limit exceeded");
		recordLlmInteraction("Normal response");
		expect(getUsageWatcherStatus().state?.consecutiveSignals).toBe(0);
	});

	test("triggers downgrade after threshold", () => {
		recordLlmInteraction("", "rate limit exceeded");
		const result = recordLlmInteraction("", "rate limit exceeded");
		expect(result).not.toBeNull();
		expect(result?.model).toBe("sonnet");
		expect(getUsageWatcherStatus().state?.currentModel).toBe("sonnet");
	});

	test("tracks total downgrades", () => {
		recordLlmInteraction("", "rate limit exceeded");
		recordLlmInteraction("", "rate limit exceeded");
		expect(getUsageWatcherStatus().state?.totalDowngrades).toBe(1);
	});

	test("reset clears state", () => {
		recordLlmInteraction("", "rate limit exceeded");
		resetUsageWatcher();
		expect(getUsageWatcherStatus().state?.consecutiveSignals).toBe(0);
	});
});

describe("wrapProviderWithWatcher", () => {
	test("wraps generate and detects signals", async () => {
		initUsageWatcher(
			{
				enabled: true,
				checkIntervalMs: 0,
				triggerThreshold: 1,
				cooldownMs: 1000,
				restartOnDowngrade: false,
			},
			"claude-code",
			"opus",
		);

		const mockProvider: LlmProvider = {
			name: "test",
			async generate() { return "normal result"; },
			async available() { return true; },
		};

		const wrapped = wrapProviderWithWatcher(mockProvider);
		const result = await wrapped.generate("test prompt");
		expect(result).toBe("normal result");
		expect(getUsageWatcherStatus().state?.consecutiveSignals).toBe(0);
	});

	test("detects rate limits in errors", async () => {
		initUsageWatcher(
			{
				enabled: true,
				checkIntervalMs: 0,
				triggerThreshold: 3,
				cooldownMs: 1000,
				restartOnDowngrade: false,
			},
			"claude-code",
			"opus",
		);

		const mockProvider: LlmProvider = {
			name: "test",
			async generate() { throw new Error("429 Too many requests"); },
			async available() { return true; },
		};

		const wrapped = wrapProviderWithWatcher(mockProvider);
		try {
			await wrapped.generate("test prompt");
		} catch {
			// expected
		}
		expect(getUsageWatcherStatus().state?.consecutiveSignals).toBe(1);
		expect(getUsageWatcherStatus().state?.totalSignalsDetected).toBe(1);
	});
});

describe("restart breadcrumb persistence", () => {
	const testDir = join(tmpdir(), `signet-watcher-test-${Date.now()}`);

	beforeEach(() => {
		mkdirSync(join(testDir, ".daemon"), { recursive: true });
	});

	test("write and consume breadcrumb round-trips", () => {
		writeRestartBreadcrumb(testDir, "opus", "haiku", "claude-code");

		const crumb = consumeRestartBreadcrumb(testDir);
		expect(crumb).not.toBeNull();
		expect(crumb?.previousModel).toBe("opus");
		expect(crumb?.downgradedModel).toBe("haiku");
		expect(crumb?.provider).toBe("claude-code");
		expect(crumb?.reason).toBe("usage-limit-downgrade");
	});

	test("consuming removes the breadcrumb file", () => {
		writeRestartBreadcrumb(testDir, "opus", "haiku", "claude-code");
		consumeRestartBreadcrumb(testDir);

		// Second consume should return null
		const second = consumeRestartBreadcrumb(testDir);
		expect(second).toBeNull();
	});

	test("returns null when no breadcrumb exists", () => {
		const emptyDir = join(tmpdir(), `signet-watcher-empty-${Date.now()}`);
		mkdirSync(join(emptyDir, ".daemon"), { recursive: true });
		const crumb = consumeRestartBreadcrumb(emptyDir);
		expect(crumb).toBeNull();
	});

	// Cleanup
	test("cleanup temp dir", () => {
		try { rmSync(testDir, { recursive: true }); } catch { /* ignore */ }
		expect(true).toBe(true);
	});
});
