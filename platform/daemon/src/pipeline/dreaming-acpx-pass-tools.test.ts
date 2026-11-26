import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "../inference-router";
import { registerPipelineRoutes } from "../routes/pipeline-routes";
import { localPrincipal } from "../auth/principal";
import { type DreamingAgentExecutor, runDreamingAgentPass } from "./dreaming";
import { DEFAULT_DREAMING_POLICIES } from "./dreaming-policies";

const AGENT = "default";
const CONFIG: DreamingConfig = {
	enabled: true,
	tokenThreshold: 1,
	maxInterval: 6 * 60 * 60 * 1_000,
	maxInputTokens: 32_000,
	maxOutputTokens: 16_000,
	timeout: 60_000,
	backfillOnFirstRun: true,
	maxConcurrentPasses: 1,
	codemode: false,
	policies: DEFAULT_DREAMING_POLICIES,
};

interface ToolReply {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

function writeAcpxAgent(root: string, script: string): void {
	const agent = join(root, "acpx-agent.ts");
	const bin = join(root, "acpx-agent.sh");
	writeFileSync(
		agent,
		`const args = process.argv.slice(2);
const config = JSON.parse(await Bun.file(args[args.indexOf("--mcp-config") + 1]).text());
const env = Object.fromEntries(config.mcpServers[0].env.map((entry) => [entry.name, entry.value]));
await Bun.stdin.text();
async function call(capability, input) {
	const response = await fetch(env.SIGNET_DAEMON_URL + "/api/dream/tools/" + capability, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			input,
			agentId: env.SIGNET_DREAMING_AGENT_ID,
			actor: "dreaming-acpx",
			passId: env.SIGNET_DREAMING_PASS_ID,
		}),
	});
	return { status: response.status, body: await response.json() };
}
${script}
`,
	);
	writeFileSync(bin, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)} "$@"\n`);
	chmodSync(bin, 0o755);
	writeFileSync(
		join(root, "agent.yaml"),
		`inference:
  defaultPolicy: dreaming
  targets:
    dreaming:
      executor: acpx
      acpx:
        agent: codex
        bin: ${bin}
        permissions: deny-all
        hooks: disabled
        terminal: false
      models:
        default:
          model: gpt-5.4-mini
  policies:
    dreaming:
      mode: strict
      defaultTargets:
        - dreaming/default
  workloads:
    memoryExtraction:
      policy: dreaming
`,
	);
}

describe("A Dreaming pass run by an out-of-process ACPX agent", () => {
	let dir = "";
	let previous: string | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-acpx-pass-tools-"));
		previous = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("principal", localPrincipal());
			await next();
		});
		registerPipelineRoutes(app);
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
	});

	afterEach(async () => {
		await server?.stop(true);
		resetInferenceRouterForTests();
		await closeDbAccessor();
		if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	function executor(): DreamingAgentExecutor {
		return {
			async run(input) {
				const result = await getOrCreateInferenceRouter(dir).runAgent(
					{ agentId: AGENT, operation: "memory_extraction", promptPreview: "acpx pass tools" },
					input.prompt,
					input.tools,
					{
						timeoutMs: input.timeoutMs,
						acpxMcp: { agentId: AGENT, passId: input.passId, daemonUrl: `http://127.0.0.1:${server?.port}` },
					},
				);
				if (!result.ok) throw new Error(result.error.message);
				return {
					summary: "Reviewed the queued evidence",
					usage: result.value.attempts.find((attempt) => attempt.ok)?.usage ?? null,
				};
			},
		};
	}

	async function seedTranscript(): Promise<void> {
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO session_transcripts (session_key, content, agent_id, created_at, updated_at, completed_at)
				 VALUES ('acpx-evidence', 'User: The staging database moved to the new cluster on Tuesday.', ?,
				         datetime('now'), datetime('now'), datetime('now'))`,
			).run(AGENT);
		});
	}

	function post(passId: string, capability: string, agentId = AGENT): Promise<Response> {
		return fetch(`http://127.0.0.1:${server?.port}/api/dream/tools/${capability}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input: {}, agentId, passId }),
		});
	}

	it("reads and acknowledges evidence through the running pass, then refuses the finished pass", async () => {
		await seedTranscript();
		const replies = join(dir, "replies.json");
		writeAcpxAgent(
			dir,
			`const page = await call("search_evidence", {});
const items = (page.body.items ?? []).map((item) => ({ sourceRef: item.sourceRef, contentOffset: item.contentOffset }));
const review = await call("review_evidence", { items });
await Bun.write(${JSON.stringify(replies)}, JSON.stringify({ page, review }));
console.log("dreaming agent completed");`,
		);

		const pass = await runDreamingAgentPass(getDbAccessor(), executor(), CONFIG, dir, AGENT, [AGENT], "incremental");

		const seen: { readonly page: ToolReply; readonly review: ToolReply } = JSON.parse(readFileSync(replies, "utf8"));
		expect(seen.page.status).toBe(200);
		expect(seen.page.body.items).toEqual([expect.objectContaining({ sourceRef: "transcript:acpx-evidence" })]);
		expect(seen.review).toMatchObject({ status: 200, body: { ok: true, agentId: AGENT } });
		const state = await getDbAccessor().withReadDbAsync((db) => ({
			calls: db
				.prepare("SELECT tool_name AS tool, success FROM dreaming_tool_calls WHERE pass_id = ? ORDER BY sequence")
				.all(pass.passId),
			cursor: db
				.prepare(
					"SELECT delivered_offset AS delivered, source_length AS length FROM dreaming_evidence_consumption WHERE source_id = 'acpx-evidence'",
				)
				.get(),
		}));
		expect(state.calls).toEqual([
			{ tool: "search_evidence", success: 1 },
			{ tool: "review_evidence", success: 1 },
		]);
		expect(state.cursor).toEqual({ delivered: expect.any(Number), length: expect.any(Number) });
		const cursor = state.cursor as { readonly delivered: number; readonly length: number };
		expect(cursor.delivered).toBe(cursor.length);
		expect(cursor.delivered).toBeGreaterThan(0);

		const late = await post(pass.passId, "search_evidence");
		expect(late.status).toBe(409);
	}, 30_000);

	it("stages the memory-head commit of a content pass so the pass can finalize", async () => {
		await seedTranscript();
		const replies = join(dir, "head.json");
		writeAcpxAgent(
			dir,
			`const read = await call("memory_head_read", {});
const commit = await call("memory_head_commit", { entries: [] });
await Bun.write(${JSON.stringify(replies)}, JSON.stringify({ read, commit }));
console.log("dreaming agent completed");`,
		);

		const pass = await runDreamingAgentPass(
			getDbAccessor(),
			executor(),
			CONFIG,
			dir,
			AGENT,
			[AGENT],
			"incremental-content",
		);

		const seen: { readonly read: ToolReply; readonly commit: ToolReply } = JSON.parse(readFileSync(replies, "utf8"));
		expect(seen.read).toMatchObject({ status: 200, body: { ok: true } });
		expect(seen.commit).toMatchObject({ status: 200, body: { ok: true, code: "STAGED_FOR_FINALIZATION" } });
		const row = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT status FROM dreaming_passes WHERE id = ?").get(pass.passId),
		);
		expect(row).toEqual({ status: "completed" });
	}, 30_000);

	async function passTokens(passId: string): Promise<unknown> {
		return getDbAccessor().withReadDbAsync((db) =>
			db
				.prepare(
					`SELECT status, tokens_consumed AS consumed, tokens_input AS input, tokens_output AS output,
					        tokens_cache_read AS cacheRead, tokens_cache_write AS cacheWrite
					 FROM dreaming_passes WHERE id = ?`,
				)
				.get(passId),
		);
	}

	it("records the token usage the ACPX agent reports instead of the prompt size", async () => {
		await seedTranscript();
		writeAcpxAgent(
			dir,
			`console.error("[acpx] tokens: input=1200000 output=34000 cache_read=900000 cache_write=6000 total=2140000");
console.log("dreaming agent completed");`,
		);

		const pass = await runDreamingAgentPass(getDbAccessor(), executor(), CONFIG, dir, AGENT, [AGENT], "incremental");

		expect(await passTokens(pass.passId)).toEqual({
			status: "completed",
			consumed: 2_140_000,
			input: 1_200_000,
			output: 34_000,
			cacheRead: 900_000,
			cacheWrite: 6_000,
		});
	}, 30_000);

	it("leaves the token counts unknown when the ACPX agent reports no usage", async () => {
		await seedTranscript();
		writeAcpxAgent(dir, `console.log("dreaming agent completed");`);

		const pass = await runDreamingAgentPass(getDbAccessor(), executor(), CONFIG, dir, AGENT, [AGENT], "incremental");

		expect(await passTokens(pass.passId)).toEqual({
			status: "completed",
			consumed: null,
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
		});
	}, 30_000);

	it("releases the pass binding when the agent exits with an error", async () => {
		const reply = join(dir, "reply.json");
		writeAcpxAgent(
			dir,
			`await Bun.write(${JSON.stringify(reply)}, JSON.stringify(await call("search_evidence", {})));
process.exit(1);`,
		);
		const seen: unknown[] = [];
		const result = await getOrCreateInferenceRouter(dir).runAgent(
			{ agentId: AGENT, operation: "memory_extraction", promptPreview: "acpx pass tools" },
			"Use the daemon tools.",
			[
				{
					name: "search_evidence",
					label: "Search evidence",
					description: "test",
					parameters: {},
					async execute(_id, input) {
						seen.push(input);
						return {
							content: [{ type: "text", text: JSON.stringify({ tool: "search_evidence", ok: true, items: [] }) }],
							details: { tool: "search_evidence" },
						};
					},
				},
			],
			{ acpxMcp: { agentId: AGENT, passId: "pass-failing", daemonUrl: `http://127.0.0.1:${server?.port}` } },
		);

		expect(result.ok).toBe(false);
		expect(JSON.parse(readFileSync(reply, "utf8"))).toMatchObject({ status: 200, body: { ok: true, agentId: AGENT } });
		expect(seen).toEqual([{ agentId: AGENT }]);
		expect((await post("pass-failing", "search_evidence")).status).toBe(409);
	}, 30_000);
});
