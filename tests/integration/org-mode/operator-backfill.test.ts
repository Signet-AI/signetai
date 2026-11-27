import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { browser, record, request, success, text, until } from "./http";

test("operator backfill uses the pinned embedding profile and bounds hanging response bodies", async () => {
	let hanging = false;
	let slow = false;
	let calls = 0;
	let cancelled = false;
	const provider = Bun.serve({
		idleTimeout: 0,
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (!new URL(req.url).pathname.endsWith("/api/embeddings")) return Response.json({ models: [] });
			calls++;
			if (hanging)
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"embedding":['));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			if (slow) {
				let timer: ReturnType<typeof setTimeout>;
				return new Response(
					new ReadableStream({
						start(controller) {
							timer = setTimeout(() => {
								controller.enqueue(
									new TextEncoder().encode(JSON.stringify({ embedding: Array.from({ length: 768 }, () => 0.01) })),
								);
								controller.close();
							}, 9000);
						},
						cancel() {
							clearTimeout(timer);
							cancelled = true;
						},
					}),
				);
			}
			return Response.json({ embedding: Array.from({ length: 768 }, () => 0.01) });
		},
	});
	const daemon = await OrgDaemon.create();
	try {
		const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await daemon.setupToken(),
			organizationName: "Backfill proof",
			admin: { username: "admin", displayName: "Admin", password: "isolated fixture password" },
		});
		success(claim, "claim");
		const admin = browser(claim);
		const identity = success(await request(daemon.origin, "/api/auth/whoami", admin), "identity");
		const agentId = text(record(identity.agents).defaultWrite);
		success(
			await request(daemon.origin, "/api/memory/remember", admin, "POST", {
				content: "Pinned operator profile happy path evidence",
				agentId,
			}),
			"remember",
		);
		await daemon.stop();
		const config = join(daemon.workspace, "agent.yaml");
		await writeFile(
			config,
			(await readFile(config, "utf8")).replace(
				"provider: none",
				`provider: ollama\n  model: configured-not-active\n  base_url: ${provider.url.origin}`,
			),
		);
		const database = new Database(join(daemon.workspace, "data/signet.db"));
		const profile = {
			provider: "ollama",
			model: "operator-fake",
			dimensions: 768,
			baseUrl: provider.url.origin,
			fingerprint: JSON.stringify({
				profile: "custom:ollama:operator-fake",
				provider: "ollama",
				model: "operator-fake",
				dimensions: 768,
			}),
		};
		database
			.prepare(
				"UPDATE embedding_index_state SET active_profile_json=?,state='ready',staging_profile_json=NULL WHERE id=1",
			)
			.run(JSON.stringify(profile));
		expect(database.prepare("SELECT active_profile_json FROM embedding_index_state WHERE id=1").get()).toEqual({
			active_profile_json: JSON.stringify(profile),
		});
		database.close();
		await daemon.start();
		const start = async () =>
			text(
				success(
					await request(daemon.origin, "/api/org/operator/jobs", admin, "POST", {
						action: "embed.backfill",
						agentId,
						options: { dryRun: false },
					}),
					"backfill admission",
				).jobId,
			);
		const wait = async (id: string) => {
			let job: Record<string, unknown> = {};
			await until(
				async () => {
					job = success(await request(daemon.origin, `/api/org/jobs/${id}`, admin), "job");
					return job.status !== "running";
				},
				"backfill settlement",
				65_000,
			);
			return job;
		};
		const complete = await wait(await start());
		expect(complete.status, JSON.stringify({ complete, calls, stdout: daemon.stdout, stderr: daemon.stderr })).toBe(
			"complete",
		);
		expect(JSON.parse(text(complete.progress_json)).affected).toBe(1);
		expect(calls).toBeGreaterThan(0);
		expect(JSON.parse(text((await wait(await start())).progress_json)).missing).toBe(0);
		await daemon.stop();
		const unembedded = new Database(join(daemon.workspace, "data/signet.db"));
		unembedded
			.prepare(
				"INSERT INTO memories(id,agent_id,content,content_hash,type,memory_kind,created_at,updated_at) VALUES('hanging-source',?,'Hanging provider deadline evidence','hanging-hash','fact','episodic',?,?)",
			)
			.run(agentId, new Date().toISOString(), new Date().toISOString());
		unembedded.close();
		hanging = true;
		await daemon.start();
		const started = Date.now();
		const failed = await wait(await start());
		expect(failed.status).toBe("failed");
		expect(Date.now() - started).toBeLessThan(60_000);
		await until(async () => cancelled, "provider response cancellation", 2000);
		await daemon.stop();
		const slowRows = new Database(join(daemon.workspace, "data/signet.db"));
		for (let n = 0; n < 9; n++)
			slowRows
				.prepare(
					"INSERT INTO memories(id,agent_id,content,content_hash,type,memory_kind,created_at,updated_at) VALUES(?,?,?,?,'fact','episodic',?,?)",
				)
				.run(
					`slow-${n}`,
					agentId,
					`Slow provider evidence ${n}`,
					`slow-hash-${n}`,
					new Date().toISOString(),
					new Date().toISOString(),
				);
		slowRows.close();
		hanging = false;
		slow = true;
		cancelled = false;
		await daemon.start();
		const deadlineStart = Date.now();
		const deadlineJob = await wait(await start());
		expect(deadlineJob).toMatchObject({ status: "failed", error: "deadline_exceeded" });
		expect(Date.now() - deadlineStart).toBeGreaterThanOrEqual(55_000);
		expect(Date.now() - deadlineStart).toBeLessThan(63_000);
		await until(async () => cancelled, "whole-job deadline cancels provider response", 2000);
		expect(JSON.parse(text(deadlineJob.progress_json)).affected).toBeGreaterThan(0);
	} finally {
		await daemon.dispose();
		provider.stop(true);
	}
}, 90_000);
