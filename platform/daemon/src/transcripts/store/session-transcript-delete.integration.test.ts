import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreshWorkspaceV2 } from "@signet/core";
import { buildHermeticEnvironment } from "../../../../../scripts/run-hermetic-tests";
import { createToken, generateSecret } from "../../auth/tokens";
import { createDbOwnerClient } from "../../db/owner/client";
import type { TranscriptCaptureAdmission } from "./lifecycle";
import { appendCanonicalTranscriptTurns, canonicalTranscriptPath } from "./jsonl";

async function until(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Transcript daemon observation timed out");
}

test("real daemon retains pinned recall, restores bypass, and captures a reused session's end snapshot", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-transcript-delete-live-"));
	const workspace = join(root, "workspace");
	const layout = createFreshWorkspaceV2(workspace);
	mkdirSync(layout.runtime, { recursive: true });
	writeFileSync(
		join(workspace, "agent.yaml"),
		"version: 1\nconfigVersion: 9\nembedding:\n  provider: none\nharnesses: []\ncapabilities:\n  identity:\n    mode: off\nauth:\n  mode: team\nmemory:\n  dreaming:\n    enabled: false\n  pipelineV2:\n    enabled: false\n    reranker:\n      enabled: false\n",
	);
	const secret = generateSecret();
	writeFileSync(join(layout.runtime, "auth-secret"), secret);
	const token = createToken(secret, { sub: "transcript-test", role: "agent", scope: { agent: "agent-a" } }, 600);
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	const port = listener.port;
	listener.stop(true);
	const base = `http://127.0.0.1:${port}`;
	const env = {
		...buildHermeticEnvironment({ PATH: process.env.PATH, LANG: "C.UTF-8" }, root),
		SIGNET_PATH: workspace,
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		SIGNET_DAEMON_ENTRYPOINT: "1",
		SIGNET_EMBEDDING_WARM_NATIVE: "false",
		SIGNET_TELEMETRY_OPTOUT: "1",
		SIGNET_ANALYTICS_DISABLED: "1",
	};
	const seed = createDbOwnerClient({ dbPath: layout.database });
	try {
		await seed.initialize(workspace);
		const capturedAt = new Date(Date.now() - 10000).toISOString();
		for (const [agentId, sessionKey, text] of [
			["agent-a", "runtime-delete", "old private quokka"],
			["agent-b", "runtime-delete", "other agent quokka"],
			["agent-a", "runtime-keep", "other session quokka"],
		]) {
			if (!agentId || !sessionKey || !text) throw new Error("Invalid fixture");
			await seed.submit(
				{
					kind: "session_transcript_write",
					input: {
						agentId,
						sessionKey,
						transcript: `User: ${text}`,
						harness: "codex",
						project: "project-a",
						capturedAt,
					},
				},
				{ operation: "test.seed-transcript", lane: "write", deadlineMs: 5000 },
			).result;
			const admission = await seed.submit<TranscriptCaptureAdmission>(
				{
					kind: "session_transcript_capture",
					input: {
						kind: "turns",
						input: {
							basePath: workspace,
							agentId,
							sessionKey,
							harness: "codex",
							sourceFormat: "live",
							capturedAt,
							turns: [{ role: "user", content: text }],
						},
					},
				},
				{ operation: "test.seed-canonical-admission", lane: "write", deadlineMs: 5000 },
			).result;
			if (
				!admission ||
				!("status" in admission) ||
				admission.status !== "admitted" ||
				admission.capture.kind !== "turns"
			) {
				throw new Error("Canonical seed was not admitted");
			}
			await appendCanonicalTranscriptTurns(admission.capture.input);
		}
		const seeded = readFileSync(canonicalTranscriptPath(workspace, "codex"), "utf8");
		expect(seeded).toContain("old private quokka");
		expect(seeded).toContain("other agent quokka");
		expect(seeded).toContain("other session quokka");
		await seed.submit(
			{
				kind: "batch",
				statements: [
					{
						sql: "INSERT INTO session_claims (session_key,agent_id,runtime_path,harness,claimed_at,expires_at,state) VALUES ('runtime-delete','agent-a','plugin','codex',?,?,'active')",
						params: [capturedAt, new Date(Date.now() + 60000).toISOString()],
						result: "run",
					},
					...["single", "mixed", "pinned"].map((id) => ({
						sql: "INSERT INTO memories (id,content,type,agent_id,pinned,created_at,updated_at) VALUES (?,?,'fact','agent-a',?,?,?)",
						params: [id, `quokka retention ${id}`, id === "pinned" ? 1 : 0, capturedAt, capturedAt],
						result: "run" as const,
					})),
					...["single", "mixed", "pinned"].map((id) => ({
						sql: "INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES (?,'transcript','runtime-delete','agent-a',?)",
						params: [id, capturedAt],
						result: "run" as const,
					})),
					{
						sql: "INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES ('mixed','transcript','runtime-keep','agent-a',?)",
						params: [capturedAt],
						result: "run",
					},
				],
			},
			{ operation: "test.seed-lineage", lane: "write", deadlineMs: 5000 },
		).result;
	} finally {
		await seed.close();
	}
	const request = async (path: string, method = "GET", body?: object): Promise<Response> =>
		await fetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(5000),
		});
	const start = async () => {
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../daemon.ts")], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		return { child, stdout, stderr };
	};
	const stop = async (daemon: Awaited<ReturnType<typeof start>>): Promise<void> => {
		if (daemon.child.exitCode === null) daemon.child.kill("SIGTERM");
		const timer = setTimeout(() => daemon.child.kill("SIGKILL"), 12000);
		try {
			await daemon.child.exited;
			expect(daemon.child.exitCode, `${await daemon.stdout}\n${await daemon.stderr}`).toBe(0);
		} finally {
			clearTimeout(timer);
		}
	};
	let daemon: Awaited<ReturnType<typeof start>> | undefined;
	try {
		daemon = await start();
		const ready = async (): Promise<boolean> => {
			try {
				return (await request("/health/ready")).ok;
			} catch {
				return false;
			}
		};
		await until(ready);
		expect((await request("/api/sessions/runtime-delete/transcript?agent_id=agent-b", "DELETE")).status).toBe(404);
		expect(
			(await request("/api/sessions/runtime-delete/transcript?agent_id=agent-a&purge=hard", "DELETE")).status,
		).toBe(403);
		const deletion = await request("/api/sessions/runtime-delete/transcript?agent_id=agent-a", "DELETE");
		expect(deletion.status).toBe(200);
		const receipt = await deletion.json();
		expect(receipt).toMatchObject({
			status: "complete",
			generation: 1,
			bypassed: true,
			retainedPinned: 1,
			counts: { memories: 1, retainedMixed: 1 },
		});
		expect(await (await request("/api/sessions/runtime-delete/transcript?agent_id=agent-a", "DELETE")).json()).toEqual(
			receipt,
		);
		expect(
			(await request("/api/sessions/runtime-delete/bypass?agent_id=agent-a", "POST", { enabled: false })).status,
		).toBe(409);
		const recall = await request("/api/memory/recall", "POST", {
			query: "quokka retention",
			agentId: "agent-a",
			limit: 20,
		});
		expect(recall.status).toBe(200);
		const recalled = JSON.stringify(await recall.json());
		expect(recalled).toContain('"id":"pinned"');
		expect(recalled).not.toContain('"id":"single"');
		await stop(daemon);
		daemon = await start();
		await until(ready);
		const body = {
			harness: "codex",
			agentId: "agent-a",
			sessionKey: "runtime-delete",
			runtimePath: "plugin",
			project: "project-a",
		};
		expect(
			await (
				await request("/api/hooks/user-prompt-submit", "POST", { ...body, userMessage: "blocked private append" })
			).json(),
		).toMatchObject({ bypassed: true });
		expect(await (await request("/api/hooks/session-end", "POST", body)).json()).toMatchObject({ bypassed: true });
		expect((await request("/api/hooks/session-start", "POST", { ...body, claimOnly: true })).status).toBe(200);
		expect(
			(await request("/api/sessions/runtime-delete/transcript?agent_id=agent-a&generation=1", "DELETE")).status,
		).toBe(409);
		const ended = await request("/api/hooks/session-end", "POST", {
			...body,
			reason: "session_shutdown",
			capturedAt: new Date().toISOString(),
			transcript: "User: new telescope quokka",
		});
		expect(ended.status).toBe(200);
		const capture = await ended.json();
		expect(capture.queued).toBe(true);
		await until(
			async () =>
				(
					await (
						await request(`/api/hooks/transcript-capture/${capture.transcriptCaptureJobId}?agentId=agent-a`)
					).json()
				).status === "completed",
		);
		await stop(daemon);
		daemon = undefined;
		const bytes = readFileSync(canonicalTranscriptPath(workspace, "codex"), "utf8");
		expect(bytes).toContain("new telescope quokka");
		expect(bytes).not.toContain("old private quokka");
		expect(bytes).not.toContain("blocked private append");
		expect(bytes).toContain("other agent quokka");
		expect(bytes).toContain("other session quokka");
	} finally {
		try {
			if (daemon) await stop(daemon);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
}, 90000);
