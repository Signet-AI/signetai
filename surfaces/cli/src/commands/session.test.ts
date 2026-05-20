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
