import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerMemoryCommands } from "./memory";

const prevLog = console.log;

afterEach(() => {
	console.log = prevLog;
});

describe("registerMemoryCommands remember", () => {
	test("omits prospective recall hints when not provided", async () => {
		let capturedBody: unknown;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body) => {
				capturedBody = body;
				return {
					ok: true,
					data: { id: "mem-1", embedded: true },
				};
			},
		});

		await program.parseAsync(["node", "test", "remember", "A memory without hints"]);

		expect(capturedBody).toEqual({
			content: "A memory without hints",
			importance: 0.7,
			who: "user",
		});
	});

	test("forwards repeated prospective recall hints", async () => {
		let capturedBody: unknown;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body) => {
				capturedBody = body;
				return {
					ok: true,
					data: { id: "mem-1", embedded: true },
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"remember",
			"Avery said Signet recall works in the terminal",
			"--hint",
			"What did Avery say about Signet recall?",
			"--hint",
			"Can Signet recall be useful from the terminal?",
		]);

		expect(capturedBody).toEqual({
			content: "Avery said Signet recall works in the terminal",
			importance: 0.7,
			who: "user",
			hints: ["What did Avery say about Signet recall?", "Can Signet recall be useful from the terminal?"],
		});
	});

	test("forwards explicit temporal memory fields", async () => {
		let capturedBody: unknown;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body) => {
				capturedBody = body;
				return {
					ok: true,
					data: { id: "mem-1", embedded: true },
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"remember",
			"We debugged exact date recall",
			"--occurred-at",
			"2026-05-13T18:00:00.000Z",
			"--source-created-at",
			"2026-05-13T17:00:00.000Z",
		]);

		expect(capturedBody).toEqual({
			content: "We debugged exact date recall",
			importance: 0.7,
			who: "user",
			occurredAt: "2026-05-13T18:00:00.000Z",
			sourceCreatedAt: "2026-05-13T17:00:00.000Z",
		});
	});
});

describe("registerMemoryCommands recall", () => {
	test("prints the full daemon response for --json", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async () => ({
				ok: true,
				data: {
					query: "deploy checklist",
					method: "hybrid",
					results: [],
					meta: {
						totalReturned: 0,
						hasSupplementary: false,
						noHits: true,
					},
				},
			}),
		});

		await program.parseAsync(["node", "test", "recall", "deploy checklist", "--json"]);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"query": "deploy checklist"');
		expect(lines[0]).toContain('"meta"');
	});

	test("forwards recall filters and applies min-score in json mode", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedBody: unknown;
		let capturedTimeout: number | undefined;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body, timeoutMs) => {
				capturedBody = body;
				capturedTimeout = timeoutMs;
				return {
					ok: true,
					data: {
						query: "deploy checklist",
						method: "hybrid",
						results: [
							{ content: "low score row", score: 0.2 },
							{ content: "high score row", score: 0.95, supplementary: true },
						],
						meta: {
							totalReturned: 2,
							hasSupplementary: true,
							noHits: false,
						},
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"recall",
			"deploy checklist",
			"--keyword-query",
			"deploy OR rollback",
			"--project",
			"/tmp/proj",
			"--type",
			"decision",
			"--tags",
			"release",
			"--who",
			"claude-code",
			"--pinned",
			"--importance-min",
			"0.7",
			"--since",
			"2026-01-01",
			"--until",
			"2026-04-01",
			"--time-start",
			"2026-05-13T00:00:00.000Z",
			"--time-end",
			"2026-05-14T00:00:00.000Z",
			"--time-facets",
			"session,occurred",
			"--time-mode",
			"timeline",
			"--min-score",
			"0.8",
			"--json",
		]);

		expect(capturedBody).toEqual({
			query: "deploy checklist",
			keywordQuery: "deploy OR rollback",
			limit: 10,
			project: "/tmp/proj",
			type: "decision",
			tags: "release",
			who: "claude-code",
			pinned: true,
			importance_min: 0.7,
			since: "2026-01-01",
			until: "2026-04-01",
			time: {
				start: "2026-05-13T00:00:00.000Z",
				end: "2026-05-14T00:00:00.000Z",
				facets: ["session", "occurred"],
				mode: "timeline",
			},
		});
		expect(capturedTimeout).toBe(30_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"high score row"');
		expect(lines[0]).not.toContain('"low score row"');
		expect(lines[0]).toContain('"totalReturned": 1');
	});

	test("forwards aggregate recall flags", async () => {
		let capturedBody: unknown;
		let capturedTimeout: number | undefined;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body, timeoutMs) => {
				capturedBody = body;
				capturedTimeout = timeoutMs;
				return {
					ok: true,
					data: {
						query: "project history",
						method: "hybrid",
						results: [],
						meta: {
							totalReturned: 0,
							hasSupplementary: false,
							noHits: true,
						},
					},
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"recall",
			"project history",
			"--aggregate",
			"--aggregate-budget",
			"large",
			"--no-save-aggregate",
			"--json",
		]);

		expect(capturedBody).toMatchObject({
			query: "project history",
			aggregate: true,
			aggregateBudget: "large",
			saveAggregate: false,
		});
		expect(capturedTimeout).toBe(120_000);
	});

	test("--no-save-aggregate does not enable aggregate recall by itself", async () => {
		let capturedBody: unknown;
		let capturedTimeout: number | undefined;
		const program = new Command();
		registerMemoryCommands(program, {
			ensureDaemonForSecrets: async () => true,
			secretApiCall: async (_method, _path, body, timeoutMs) => {
				capturedBody = body;
				capturedTimeout = timeoutMs;
				return {
					ok: true,
					data: {
						query: "project history",
						method: "hybrid",
						results: [],
						meta: {
							totalReturned: 0,
							hasSupplementary: false,
							noHits: true,
						},
					},
				};
			},
		});

		await program.parseAsync(["node", "test", "recall", "project history", "--no-save-aggregate", "--json"]);

		expect(capturedBody).toEqual({
			query: "project history",
			limit: 10,
		});
		expect(capturedTimeout).toBe(30_000);
	});
});
