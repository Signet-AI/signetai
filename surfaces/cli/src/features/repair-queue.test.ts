/**
 * Issue #901 — tests for repair-queue CLI helpers (runRepairQueue, parsing).
 */

import { describe, expect, it } from "bun:test";
import { parseCsvFlag, parseDurationFlag, runRepairQueue } from "./repair-queue.js";

describe("parseCsvFlag", () => {
	it("returns [] for undefined", () => {
		expect(parseCsvFlag(undefined)).toEqual([]);
	});

	it("splits on commas and trims", () => {
		expect(parseCsvFlag("a, b ,c")).toEqual(["a", "b", "c"]);
	});

	it("drops empty parts", () => {
		expect(parseCsvFlag("a,,b,")).toEqual(["a", "b"]);
	});
});

describe("parseDurationFlag", () => {
	it("returns undefined for unrecognized", () => {
		expect(parseDurationFlag("foo")).toBeUndefined();
		expect(parseDurationFlag(undefined)).toBeUndefined();
	});

	it("parses common units", () => {
		expect(parseDurationFlag("7d")).toBe(7 * 24 * 60 * 60 * 1000);
		expect(parseDurationFlag("12h")).toBe(12 * 60 * 60 * 1000);
		expect(parseDurationFlag("30m")).toBe(30 * 60 * 1000);
		expect(parseDurationFlag("45s")).toBe(45 * 1000);
		expect(parseDurationFlag("600ms")).toBe(600);
	});
});

describe("runRepairQueue", () => {
	it("dry-runs cancel and renders a yellow header + preview", async () => {
		const captured: string[] = [];
		const result = await runRepairQueue(
			{
				action: "cancel",
				dryRun: true,
				tables: ["summary"],
				olderThanMs: 1000,
			},
			{
				baseUrl: "http://localhost:3850",
				apiCall: async (_m, _p, body) => {
					expect((body as { action: string }).action).toBe("cancel");
					expect((body as { dryRun: boolean }).dryRun).toBe(true);
					return {
						ok: true,
						data: {
							action: "cancelObsoleteJobs",
							success: true,
							affected: 0,
							message: "dry-run: 3 job(s) match cancel filter",
							preview: ["summary_jobs:a", "summary_jobs:b"],
							totalMatching: 3,
						},
					};
				},
				stdout: (line) => captured.push(line),
			},
		);
		expect(result.action).toBe("cancelObsoleteJobs");
		expect(result.preview?.length).toBe(2);
		expect(captured[0]).toMatch(/dry-run/);
		expect(captured.join("\n")).toMatch(/total matching: 3/);
	});

	it("applies requeue and renders a green header", async () => {
		const captured: string[] = [];
		const result = await runRepairQueue(
			{
				action: "requeue",
				dryRun: false,
				ids: ["abc-1"],
			},
			{
				baseUrl: "http://localhost:3850",
				apiCall: async () => ({
					ok: true,
					data: {
						action: "requeueDeadJobs",
						success: true,
						affected: 1,
						message: "requeued 1 dead summary job(s) to pending",
					},
				}),
				stdout: (line) => captured.push(line),
			},
		);
		expect(result.action).toBe("requeueDeadJobs");
		expect(captured[0]).toMatch(/\[apply\]/);
		expect(captured.join("\n")).toMatch(/requeued 1 dead summary job/);
	});

	it("falls back to a denied result when the daemon is unreachable", async () => {
		const captured: string[] = [];
		const result = await runRepairQueue(
			{ action: "prune", dryRun: true },
			{
				baseUrl: "http://localhost:3850",
				apiCall: async () => ({ ok: false, data: { error: "offline" } }),
				stdout: (line) => captured.push(line),
			},
		);
		expect(result.success).toBe(false);
		expect(captured.join("\n")).toMatch(/request failed/);
	});
});
