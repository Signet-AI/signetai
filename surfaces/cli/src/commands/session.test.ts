import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerSessionCommands } from "./session";

const prevLog = console.log;
const prevError = console.error;

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
});

describe("registerSessionCommands search", () => {
	test("posts transcript search request and prints json response", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedPath = "";
		let capturedOpts: (RequestInit & { timeout?: number }) | undefined;
		const program = new Command();
		registerSessionCommands(program, {
			fetchFromDaemon: async (path, opts) => {
				capturedPath = path;
				capturedOpts = opts;
				return {
					query: "Juniper trunk ports",
					hits: [
						{
							sessionKey: "parent-session",
							project: "/tmp/network",
							updatedAt: "2026-03-25T10:05:00.000Z",
							excerpt: "keep the Juniper EX4300 VLAN audit focused on trunk ports",
							rank: -1.2,
						},
					],
					count: 1,
				};
			},
		});

		await program.parseAsync([
			"node",
			"test",
			"session",
			"search",
			"Juniper trunk ports",
			"--session-key",
			"parent-session",
			"--current-session-key",
			"child-session",
			"--agent",
			"research-agent",
			"--project",
			"/tmp/network",
			"--limit",
			"3",
			"--json",
		]);

		expect(capturedPath).toBe("/api/sessions/search");
		expect(capturedOpts?.method).toBe("POST");
		expect(capturedOpts?.timeout).toBe(30_000);
		expect(JSON.parse(String(capturedOpts?.body))).toEqual({
			query: "Juniper trunk ports",
			sessionKey: "parent-session",
			currentSessionKey: "child-session",
			agentId: "research-agent",
			project: "/tmp/network",
			limit: 3,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"sessionKey": "parent-session"');
	});

	test("prints no-hit transcript search response", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		const program = new Command();
		registerSessionCommands(program, {
			fetchFromDaemon: async () => ({
				query: "missing",
				hits: [],
				count: 0,
			}),
		});

		await program.parseAsync(["node", "test", "session", "search", "missing"]);

		expect(lines).toEqual(["  No transcripts found"]);
	});
});

describe("registerSessionCommands session notes", () => {
	test("calls the notes route and prints json", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedPath = "";
		const program = new Command();
		registerSessionCommands(program, {
			fetchFromDaemon: async (path) => {
				capturedPath = path;
				return {
					ok: true,
					path: "/home/user/.agents/memory/sessions/test/notes.md",
					frontmatter: {
						thread_id: "test",
						agent_id: "default",
						harness: "opencode",
						cwd: "/tmp/repo",
						updated_at: "2026-06-09T22:00:00.000Z",
					},
					summaryLine: "Tested the notes CLI.",
					tasks: [
						{
							taskIndex: 1,
							outcome: "Wired the CLI command.",
							preferenceSignals: [],
							keySteps: ["Added a test"],
							failures: [],
							reusableKnowledge: [],
							references: [],
							source: "agent",
							attributedAt: "2026-06-09T22:00:00.000Z",
						},
					],
				};
			},
		});

		await program.parseAsync(["node", "test", "session", "notes", "test", "--json"]);

		expect(capturedPath).toBe("/api/sessions/test/notes");
		expect(lines).toHaveLength(1);
		const payload = JSON.parse(lines[0] ?? "{}") as { tasks: Array<{ taskIndex: number }> };
		expect(payload.tasks[0]?.taskIndex).toBe(1);
	});

	test("scopes to a single task when --task is provided", async () => {
		const lines: string[] = [];
		console.log = (line?: unknown) => {
			lines.push(String(line ?? ""));
		};

		let capturedPath = "";
		const program = new Command();
		registerSessionCommands(program, {
			fetchFromDaemon: async (path) => {
				capturedPath = path;
				return {
					ok: true,
					path: "/home/user/.agents/memory/sessions/test/notes.md",
					frontmatter: {
						thread_id: "test",
						agent_id: "default",
						harness: "opencode",
						cwd: "/tmp/repo",
						updated_at: "2026-06-09T22:00:00.000Z",
					},
					summaryLine: "",
					tasks: [
						{
							taskIndex: 2,
							outcome: "second",
							preferenceSignals: [],
							keySteps: [],
							failures: [],
							reusableKnowledge: [],
							references: [],
							source: "agent",
							attributedAt: "2026-06-09T22:00:00.000Z",
						},
					],
				};
			},
		});

		await program.parseAsync(["node", "test", "session", "notes", "test", "--task", "2", "--json"]);

		expect(capturedPath).toBe("/api/sessions/test/notes?task=2");
	});

	test("exits with an error when the daemon returns ok:false", async () => {
		const errors: string[] = [];
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		const prevExit = process.exit;
		const exits: number[] = [];
		process.exit = ((code?: number) => {
			exits.push(code ?? 0);
			throw new Error("exit");
		}) as never;

		const program = new Command();
		registerSessionCommands(program, {
			fetchFromDaemon: async () => ({
				ok: false,
				error: "Session notes not found",
			}),
		});

		try {
			await program.parseAsync(["node", "test", "session", "notes", "missing"]);
		} catch {
			/* swallow the synthetic exit */
		}
		process.exit = prevExit;

		expect(exits).toEqual([1]);
		expect(errors.join("\n")).toContain("Session notes not found");
	});
});
