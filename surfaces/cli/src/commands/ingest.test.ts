import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerIngestCommands, type IngestDeps } from "./ingest";

const prevLog = console.log;
const prevError = console.error;
// The command's error/abort paths call process.exit(1), which would kill the
// whole bun test runner. Redirect exit to a thrown error so parseAsync rejects
// and the runner keeps going.
const prevExit = process.exit;

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
	process.exit = prevExit;
});

function captureLogs(): { lines: string[]; install: () => void } {
	const lines: string[] = [];
	console.log = (line?: unknown) => {
		lines.push(String(line ?? ""));
	};
	console.error = (line?: unknown) => {
		lines.push(String(line ?? ""));
	};
	process.exit = ((code?: number) => {
		throw new Error(`process.exit(${code ?? 0})`);
	}) as never;
	return {
		lines,
		install: () => {
			console.log = prevLog;
			console.error = prevError;
			process.exit = prevExit;
		},
	};
}

/** Build a fetchDaemonResult stub; the dep's generic signature is asserted. */
function stubFetch(impl: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<unknown>): IngestDeps["fetchDaemonResult"] {
	return impl as IngestDeps["fetchDaemonResult"];
}

describe("registerIngestCommands", () => {
	test("lease posts {agent_id, context_budget} and prints the lease + machine-readable trailer", async () => {
		let capturedPath = "";
		let capturedOpts: (RequestInit & { timeout?: number }) | undefined;
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async (path, opts) => {
				capturedPath = path;
				capturedOpts = opts;
				return {
					ok: true,
					data: {
						eligible: true,
						jobId: "job-42",
						leaseToken: "tok-abc",
						leaseExpiresAt: "2026-07-21T00:00:00.000Z",
						context: {
							source: { kind: "memory", content: "a preference".repeat(10) },
							budget: { window: 200000, inputBudget: 160000 },
							tokens: { source: 7, total: 42 },
							focalEntityIds: ["e1", "e2"],
							oversize: false,
						},
					},
				};
			}),
		});

		await program.parseAsync([
			"node",
			"test",
			"ingest",
			"lease",
			"--agent",
			"ant",
			"--context-budget",
			"180000",
		]);

		install();

		expect(capturedPath).toBe("/api/ingest/lease");
		expect(capturedOpts?.method).toBe("POST");
		expect(JSON.parse(String(capturedOpts?.body))).toEqual({
			agent_id: "ant",
			context_budget: 180000,
		});
		// Human block
		const human = lines.join("\n");
		expect(human).toContain("job-42");
		expect(human).toContain("tok-abc");
		// Machine-readable trailer
		expect(human).toContain("lease_token=tok-abc job_id=job-42 eligible=true");
	});

	test("lease omits context_budget when not provided and prints eligible=false cleanly", async () => {
		let capturedBody: Record<string, unknown> = {};
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async (_path, opts) => {
				capturedBody = JSON.parse(String(opts?.body));
				return { ok: true, data: { eligible: false, jobId: null } };
			}),
		});

		await program.parseAsync(["node", "test", "ingest", "lease"]);

		install();

		// No --agent, no --context-budget → empty body object.
		expect(capturedBody).toEqual({});
		expect(lines.join("\n")).toContain("No eligible ingest jobs");
		expect(lines.join("\n")).toContain('{"eligible":false,"jobId":null}');
	});

	test("apply-plan loads the file and posts {plan, lease_token}", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ingest-apply-"));
		const plan = {
			schemaVersion: 1,
			jobId: "job-9",
			agentId: "ant",
			sourceHash: "sha_test",
			memories: [{ content: "fact", importance: 0.9, type: "fact" }],
			graphOps: [],
			filePatches: [],
		};
		const planPath = join(dir, "plan.json");
		writeFileSync(planPath, JSON.stringify(plan));

		let capturedPath = "";
		let capturedBody: Record<string, unknown> = {};
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async (path, opts) => {
				capturedPath = path;
				capturedBody = JSON.parse(String(opts?.body));
				return {
					ok: true,
					data: {
						jobId: "job-9",
						completed: true,
						memories: [{ outcome: "applied" }, { outcome: "skipped", reason: "deduped_existing" }],
						graph: { applied: 0, failed: 0, errors: [] },
						filePatches: [],
						planHash: "plan_deadbeef",
					},
				};
			}),
		});

		await program.parseAsync([
			"node",
			"test",
			"ingest",
			"apply-plan",
			"--file",
			planPath,
			"--lease-token",
			"tok-9",
		]);

		install();

		expect(capturedPath).toBe("/api/ingest/apply-plan");
		// Body contract is exactly {plan, lease_token} — agent_id is NOT sent.
		expect(Object.keys(capturedBody).sort()).toEqual(["lease_token", "plan"]);
		expect(capturedBody.lease_token).toBe("tok-9");
		expect((capturedBody.plan as { jobId: string }).jobId).toBe("job-9");

		const human = lines.join("\n");
		expect(human).toContain("completed");
		expect(human).toContain("1 applied / 1 skipped / 0 failed");
		expect(human).toContain("plan_deadbeef");
	});

	test("apply-plan with --agent that mismatches plan.agentId aborts before the round-trip", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ingest-apply-mismatch-"));
		const plan = {
			schemaVersion: 1,
			jobId: "j",
			agentId: "ant",
			sourceHash: "s",
			memories: [],
			graphOps: [],
			filePatches: [],
		};
		const planPath = join(dir, "plan.json");
		writeFileSync(planPath, JSON.stringify(plan));

		let called = false;
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async () => {
				called = true;
				return { ok: true, data: { completed: true } };
			}),
		});

		// The guard calls process.exit(1), redirected to a throw by captureLogs.
		await expect(
			program.parseAsync([
				"node",
				"test",
				"ingest",
				"apply-plan",
				"--file",
				planPath,
				"--lease-token",
				"t",
				"--agent",
				"other",
			]),
		).rejects.toThrow();

		install();
		expect(called).toBe(false);
		expect(lines.join("\n")).toContain('does not match plan.agentId "ant"');
	});

	test("status sends the agent via x-signet-agent-id header and prints queue depth", async () => {
		let capturedPath = "";
		let capturedOpts: (RequestInit & { timeout?: number }) | undefined;
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async (path, opts) => {
				capturedPath = path;
				capturedOpts = opts;
				return { ok: true, data: { agentId: "ant", queue: { pending: 3, active: 1, dead: 0 } } };
			}),
		});

		await program.parseAsync(["node", "test", "ingest", "status", "--agent", "ant"]);

		install();

		expect(capturedPath).toBe("/api/ingest/status");
		expect(capturedOpts?.method).toBe("GET");
		// GET passes the agent via header (the route reads no body on GET).
		expect(capturedOpts?.body).toBeUndefined();
		const headers = new Headers(capturedOpts?.headers);
		expect(headers.get("x-signet-agent-id")).toBe("ant");

		const human = lines.join("\n");
		expect(human).toContain("Pending:  3");
		expect(human).toContain("Active:   1");
		expect(human).toContain("Dead:     0");
	});

	test("daemon-down (offline) surfaces a structured error, not a stack trace", async () => {
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async () => ({ ok: false, reason: "offline" })),
		});

		await expect(program.parseAsync(["node", "test", "ingest", "status"])).rejects.toThrow();

		install();
		const human = lines.join("\n");
		expect(human).toContain("Failed to read ingest status");
		expect(human).toContain("Could not reach the Signet daemon");
	});

	test("non-200 (http) surfaces the status code", async () => {
		const { lines, install } = captureLogs();

		const program = new Command();
		registerIngestCommands(program, {
			fetchDaemonResult: stubFetch(async () => ({ ok: false, reason: "http", status: 400 })),
		});

		await expect(program.parseAsync(["node", "test", "ingest", "lease"])).rejects.toThrow();

		install();
		expect(lines.join("\n")).toContain("HTTP 400");
	});
});
