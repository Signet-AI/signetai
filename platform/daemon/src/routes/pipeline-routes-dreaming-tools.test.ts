import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Hono } from "hono";
import { type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { ownerReadOne } from "../db-owner-sql";
import { createDreamingAcpxMcpConfig } from "../pipeline/acpx-dreaming-mcp";
import { getDreamingToolCalls, runDreamingAgentPass } from "../pipeline/dreaming";
import { registerPipelineRoutes } from "./pipeline-routes";

describe("POST /api/dream/tools/apply_ontology_ops", () => {
	let agentsDir = "";

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dreaming-tools-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("returns a retryable 503 with the committed prefix after a writer failure (#1414)", async () => {
		const accessor = getDbAccessor();
		accessor.withWriteTx((db) => {
			for (let index = 0; index < 25; index += 1) {
				db.prepare(
					`INSERT INTO memories
					 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
					 VALUES (?, ?, 'manual', 'episodic', 'normal', 'agent-a', datetime('now'), datetime('now'))`,
				).run(`m-route-1414-${index}`, `Route retry evidence ${index}.`);
			}
		});
		const enqueue = accessor.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		let transactions = 0;
		const injectable = accessor as {
			withWriteTxAsync: <T>(fn: (db: WriteDb) => T) => Promise<T>;
		};
		injectable.withWriteTxAsync = (fn) => {
			transactions += 1;
			if (transactions === 3) return Promise.reject(new Error("injected route writer rejection"));
			return enqueue(fn);
		};
		const app = new Hono();
		registerPipelineRoutes(app);

		try {
			const response = await app.request("/api/dream/tools/apply_ontology_ops", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: "agent-a",
					input: {
						operations: Array.from({ length: 25 }, (_, index) => ({
							operation: "create_entity",
							payload: { name: `Route retry entity ${index}`, type: "project" },
							evidence: [
								{
									source_ref: `memory:m-route-1414-${index}`,
									source_kind: "manual",
									source_id: `m-route-1414-${index}`,
									quote: `Route retry evidence ${index}.`,
								},
							],
						})),
					},
				}),
			});

			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				tool: "apply_ontology_ops",
				ok: false,
				retryable: true,
				retryFrom: 20,
				error: "injected route writer rejection",
				agentId: "agent-a",
				items: Array.from({ length: 20 }, (_, index) => ({ index, ok: true })),
			});
		} finally {
			injectable.withWriteTxAsync = enqueue;
		}
	});
});

describe("POST /api/dream/tools through the ACPX Dreaming MCP server", () => {
	let agentsDir = "";
	let previousSignetPath: string | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;

	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-dreaming-acpx-route-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(join(agentsDir, "agent.yaml"), "name: DreamingAcpxRouteTest\n");
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = agentsDir;
		initDbAccessor(join(agentsDir, "memory", "memories.db"), { agentsDir });
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
				 VALUES ('head-evidence', 'Meeting is Tuesday.', 'manual', 'episodic', 'normal', 'owner', datetime('now'), datetime('now'))`,
			).run();
		});
		const app = new Hono();
		registerPipelineRoutes(app);
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	});

	afterEach(async () => {
		await server?.stop(true);
		server = undefined;
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(agentsDir, { recursive: true, force: true });
	});

	async function withAcpxMcp<T>(
		agentId: string,
		passId: string,
		use: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>,
	): Promise<T> {
		const config = createDreamingAcpxMcpConfig({ agentId, passId, daemonUrl: `http://127.0.0.1:${server?.port}` });
		const client = new Client({ name: "acpx-test", version: "test" });
		try {
			const spec = (
				JSON.parse(readFileSync(config.path, "utf8")) as {
					mcpServers: Array<{ command: string; args: string[]; env: Array<{ name: string; value: string }> }>;
				}
			).mcpServers[0];
			if (!spec) throw new Error("ACPX MCP config has no server");
			await client.connect(
				new StdioClientTransport({
					command: spec.command,
					args: spec.args,
					env: {
						PATH: process.env.PATH ?? "",
						SIGNET_PATH: agentsDir,
						...Object.fromEntries(spec.env.map((entry) => [entry.name, entry.value])),
					},
					stderr: "ignore",
				}),
			);
			return await use(async (name, args) => {
				const result = (await client.callTool({ name, arguments: args })) as {
					content: Array<{ type: string; text: string }>;
				};
				const text = result.content[0]?.text ?? "";
				return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
			});
		} finally {
			await client.close();
			config.dispose();
		}
	}

	const cfg = {
		tokenThreshold: 100000,
		maxInterval: 3600000,
		maxInputTokens: 32000,
		maxOutputTokens: 16000,
		timeout: 30000,
		backfillOnFirstRun: true,
	};
	const entries = [
		{
			entryId: "meeting",
			text: "Meeting is Tuesday.",
			support: [{ source_ref: "memory:head-evidence", quote: "Meeting is Tuesday." }],
		},
	];

	it("stages the head commit in the running content pass and completes it (#2102)", async () => {
		const accessor = getDbAccessor();
		const completed = await runDreamingAgentPass(
			accessor,
			{
				run: async (input) =>
					await withAcpxMcp("owner", input.passId, async (call) => {
						await call("memory_head_read", { agentId: "owner" });
						expect(await call("memory_head_commit", { agentId: "owner", entries })).toMatchObject({
							ok: true,
							code: "STAGED_FOR_FINALIZATION",
						});
						return { summary: "Recorded the meeting day." };
					}),
			},
			cfg,
			agentsDir,
			"owner",
			["owner"],
			"incremental-content",
		);

		const owner = await getDbOwnerForAccessor(accessor);
		const options = { operation: "acpx-head-commit-fixture", lane: "read" as const, deadlineMs: 10000 };
		expect(
			await ownerReadOne(owner, "SELECT status FROM dreaming_passes WHERE id=?", [completed.passId], options),
		).toEqual({ status: "completed" });
		expect(
			await ownerReadOne<{ content: string }>(
				owner,
				"SELECT content FROM memory_md_heads WHERE agent_id='owner'",
				[],
				options,
			),
		).toMatchObject({ content: expect.stringContaining("Meeting is Tuesday.") });
		expect(
			(await getDreamingToolCalls(accessor, "owner", completed.passId)).map((call) => [call.toolName, call.success]),
		).toEqual([
			["memory_head_read", true],
			["memory_head_commit", true],
		]);

		await withAcpxMcp("owner", completed.passId, async (call) => {
			expect(await call("memory_head_commit", { agentId: "owner", entries })).toMatchObject({
				ok: false,
				code: "PASS_NOT_AUTHORIZED",
			});
		});
	}, 60_000);

	it("rejects a head commit for the running pass from another agent scope", async () => {
		await expect(
			runDreamingAgentPass(
				getDbAccessor(),
				{
					run: async (input) =>
						await withAcpxMcp("intruder", input.passId, async (call) => {
							expect(await call("memory_head_commit", { agentId: "intruder", entries: [] })).toMatchObject({
								ok: false,
								code: "PASS_NOT_AUTHORIZED",
							});
							return { summary: "Tried to commit another scope's head." };
						}),
				},
				cfg,
				agentsDir,
				"owner",
				["owner"],
				"incremental-content",
			),
		).rejects.toThrow("the agent ended without calling memory_head_commit");
	}, 60_000);
});
