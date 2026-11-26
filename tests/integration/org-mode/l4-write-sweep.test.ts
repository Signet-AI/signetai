import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WriteSweep } from "./l4-sweep-support";
import { record, text, until, request } from "./http";

const agentLabels = ["cls_l4_agent"];
const sessionLabels = [...agentLabels, "cls_l4_session"];

test("A16 actual HTTP writes reject classified destinations without persisted side effects", async () => {
	const sweep = await WriteSweep.create();
	try {
		await sweep.seed();
		const snapshot = () =>
			sweep.read((db) =>
				Object.fromEntries(
					db
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type='table' AND name<>'db_integrity_checkpoints' ORDER BY name",
						)
						.all()
						.map(({ name }) => {
							assert(/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name));
							const rows = db
								.query(`SELECT * FROM ${name}`)
								.all()
								.map((row) =>
									JSON.stringify(row, (_key, value: unknown) =>
										typeof value === "bigint"
											? { bigint: value.toString() }
											: value instanceof Uint8Array
												? { blob: Buffer.from(value).toString("base64") }
												: value,
									),
								)
								.sort();
							return [name, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
						}),
				),
			);
		const forbiddenRoot = join(sweep.daemon.root, "forbidden-vault");
		await mkdir(forbiddenRoot);
		const { loadMemoryConfig } = await import("../../../platform/daemon/src/memory-config");
		const { embeddingProfileFingerprint, recommendedEmbeddingProfileId } = await import(
			"../../../platform/daemon/src/embedding-profile"
		);
		const configured = loadMemoryConfig(sweep.daemon.workspace).embedding;
		const fingerprint = embeddingProfileFingerprint({
			...configured,
			profile: recommendedEmbeddingProfileId(configured),
		});
		await until(
			async () =>
				sweep.read((db) => {
					const state = db
						.query<
							{
								state: string;
								active_profile_json: string;
								staging_profile_json: string | null;
								provider_endpoint: string | null;
								last_error: string | null;
							},
							[]
						>(
							"SELECT state,active_profile_json,staging_profile_json,provider_endpoint,last_error FROM embedding_index_state WHERE id=1",
						)
						.get();
					if (state === null) return false;
					const active = record(JSON.parse(state.active_profile_json));
					return (
						state.state === "ready" &&
						state.staging_profile_json === null &&
						state.last_error === null &&
						state.provider_endpoint === configured.base_url &&
						active.fingerprint === fingerprint &&
						active.baseUrl === configured.base_url
					);
				}),
			"embedding index owner settled on the configured startup profile",
			60_000,
		);
		const before = snapshot();
		const sourceConfig = Bun.file(join(sweep.daemon.workspace, "sources.json"));
		const configBefore = (await sourceConfig.exists()) ? await sourceConfig.text() : "";
		const readd = await request(sweep.daemon.origin, "/api/sources/obsidian", sweep.credential, "POST", {
			agentId: sweep.agentId,
			root: forbiddenRoot,
			name: "Forbidden source",
		});
		assert.equal(readd.status, 403, JSON.stringify(readd.body));
		assert.equal(record(readd.body).reason, "classified_destination");
		assert.equal((await sourceConfig.exists()) ? await sourceConfig.text() : "", configBefore);
		assert.deepEqual(snapshot(), before, "source add wrote persisted state");
		const common = {
			agentId: sweep.agentId,
			sessionKey: "forbidden-session",
			harness: "codex",
			content: "Forbidden evidence",
			userMessage: "Forbidden prompt",
			lastAssistantMessage: "Forbidden append",
			summary: "Forbidden summary",
			source_type: "text",
			source_url: "text://forbidden",
			type: "file",
		};
		for (const path of [
			"/api/memory/remember",
			"/api/memory/save",
			"/api/hook/remember",
			"/api/hooks/remember",
			"/api/hooks/session-start",
			"/api/hooks/user-prompt-submit",
			"/api/hooks/stop",
			"/api/hooks/pre-compaction",
			"/api/hooks/compaction-complete",
			"/api/hooks/session-end",
			"/api/documents",
			"/api/sources/imports",
		]) {
			const reply = await request(sweep.daemon.origin, path, sweep.credential, "POST", common, {
				"x-signet-session-key": common.sessionKey,
			});
			assert.equal(reply.status, 403, `${path}: ${JSON.stringify(reply.body)}`);
			assert.deepEqual(reply.body, { error: "classified destination", reason: "classified_destination" });
			assert.deepEqual(snapshot(), before, `${path} wrote persisted state`);
		}
		const form = new FormData();
		form.set("files", new File(["Forbidden file evidence"], "forbidden.md", { type: "text/markdown" }));
		const headers = new Headers({
			cookie: sweep.credential.cookie ?? "",
			"x-signet-csrf": sweep.credential.csrf ?? "",
		});
		headers.set("x-signet-session-key", common.sessionKey);
		const imported = await fetch(`${sweep.daemon.origin}/api/sources/import?agentId=${sweep.agentId}`, {
			method: "POST",
			headers,
			body: form,
		});
		assert.equal(imported.status, 403);
		assert.equal(record(await imported.json()).reason, "classified_destination");
		assert.deepEqual(snapshot(), before, "file import wrote persisted state");
	} finally {
		await sweep.dispose();
	}
}, 180_000);

test("classified evidence HTTP write sweep preserves compartments and principal authors", async () => {
	const sweep = await WriteSweep.create();
	try {
		await sweep.seed();
		const common = { harness: "codex", agentId: sweep.agentId, sessionKey: "l4-session", runtimePath: "plugin" };
		for (const path of ["/api/memory/remember", "/api/memory/save", "/api/hook/remember", "/api/hooks/remember"]) {
			await sweep.check(path, async () => {
				const result = await sweep.post(path, {
					...common,
					content: `L4 classified evidence ${path} durable capture.`,
					author_user_id: "forged",
					hints: ["L4 classified retrieval hint"],
					sourceType: "user",
					sourceId: sweep.sourceId,
				});
				sweep.assertMemory(text(result.id), [...sessionLabels, "cls_l4_source"], true);
			});
		}
		await sweep.check("remember automatic chunks", async () => {
			const result = await sweep.post("/api/memory/remember", {
				...common,
				sourceType: "user",
				sourceId: sweep.sourceId,
				content: Array.from(
					{ length: 18 },
					(_, i) =>
						`L4 chunk ${i} preserves independently authored classified evidence through automatic sentence splitting.`,
				).join(" "),
			});
			assert.equal(result.chunked, true);
			assert(Array.isArray(result.ids) && result.ids.length >= 2);
			for (const value of result.ids) {
				const memoryId = text(value);
				sweep.assertMemory(memoryId, [...sessionLabels, "cls_l4_source"]);
				assert(
					sweep.read((db) => db.query("SELECT id FROM embeddings WHERE source_id=?").get(memoryId)),
					"chunk vector must be stored",
				);
			}
		});
		await sweep.check("session-start", async () => {
			await sweep.post("/api/hooks/session-start", common);
		});
		await sweep.check("prompt-submit", async () => {
			await sweep.post("/api/hooks/user-prompt-submit", {
				...common,
				userMessage: "L4 prompt evidence must retain the credential author and the session classification.",
			});
			await until(
				async () =>
					sweep.read((db) =>
						Boolean(
							db
								.query("SELECT session_key FROM session_transcripts WHERE agent_id=? AND session_key=?")
								.get(sweep.agentId, common.sessionKey),
						),
					),
				"prompt evidence",
			);
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND session_key=?",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"speaker_user_id",
			);
		});
		await sweep.check("stop", async () => {
			await sweep.post("/api/hooks/stop", {
				...common,
				lastAssistantMessage: "L4 assistant stop evidence is durable and classified.",
			});
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND session_key=?",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"speaker_user_id",
			);
		});
		await sweep.check("remember inline transcript", async () => {
			const result = await sweep.post("/api/memory/remember", {
				...common,
				sourceType: "codex",
				sourceId: common.sessionKey,
				content: "L4 inline transcript memory preserves principal attribution.",
				transcript: "User: L4 inline transcript evidence.\nAssistant: L4 inline transcript answer.",
			});
			sweep.assertMemory(text(result.id), sessionLabels);
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND session_key=?",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"speaker_user_id",
			);
		});
		await sweep.check("stored cross-agent message", async () => {
			await sweep.post("/api/cross-agent/messages", {
				fromAgentId: sweep.agentId,
				fromSessionKey: common.sessionKey,
				toAgentId: "default",
				content: "L4 message content is classified evidence.",
			});
			sweep.assertRows(
				"cross_agent_messages",
				"from_agent_id=? AND content LIKE 'L4 message%'",
				[sweep.agentId],
				sessionLabels,
				"author_user_id",
			);
		});
		await sweep.check("pre-compaction checkpoint", async () => {
			await sweep.post("/api/hooks/pre-compaction", {
				...common,
				messageCount: 4,
				sessionContext: "L4 classified checkpoint context.",
			});
			await until(
				async () =>
					sweep.read((db) =>
						Boolean(
							db
								.query("SELECT id FROM session_checkpoints WHERE agent_id=? AND session_key=?")
								.get(sweep.agentId, common.sessionKey),
						),
					),
				"pre-compaction checkpoint durability",
				5_000,
			);
			sweep.assertRows(
				"session_checkpoints",
				"agent_id=? AND session_key=?",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"author_user_id",
			);
		});
		await sweep.check("compaction-complete", async () => {
			const summary = await sweep.post("/api/hooks/compaction-complete", {
				...common,
				summary: "L4 compacted evidence preserves classification and authorship.",
			});
			sweep.assertMemory(text(summary.memoryId), sessionLabels);
			sweep.assertRows(
				"session_summaries",
				"agent_id=? AND session_key=?",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"author_user_id",
			);
		});
		await sweep.check("compaction artifact", async () => {
			sweep.assertRows(
				"memory_artifacts",
				"agent_id=? AND session_key=? AND source_kind='compaction'",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"author_user_id",
			);
		});
		await sweep.check("session-end", async () => {
			await sweep.post("/api/hooks/session-end", {
				...common,
				transcript: "User: L4 final evidence.\nAssistant: L4 durable response.",
				lastAssistantMessage: "L4 durable response.",
			});
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND session_key=?",
				[sweep.agentId, common.sessionKey],
				sessionLabels,
				"speaker_user_id",
			);
		});
		await sweep.check("standalone stop principal", async () => {
			await sweep.post("/api/hooks/session-start", { ...common, sessionKey: "l4-stop" });
			await sweep.post("/api/hooks/stop", {
				...common,
				sessionKey: "l4-stop",
				lastAssistantMessage: "L4 standalone stop records new evidence under the authenticated principal.",
			});
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND session_key=?",
				[sweep.agentId, "l4-stop"],
				sessionLabels,
				"speaker_user_id",
			);
		});
		await sweep.check("session shutdown capture", async () => {
			const sessionKey = "l4-shutdown";
			await sweep.post("/api/hooks/session-start", { ...common, sessionKey });
			const result = await sweep.post("/api/hooks/session-end", {
				...common,
				sessionKey,
				reason: "session_shutdown",
				transcript: "User: L4 shutdown transcript evidence.\nAssistant: L4 shutdown response.",
			});
			const jobId = text(result.transcriptCaptureJobId);
			await until(
				async () =>
					sweep.read((db) => {
						const job = db
							.query<{ status: string; error: string | null }, [string]>(
								"SELECT status,error FROM transcript_capture_jobs WHERE id=?",
							)
							.get(jobId);
						assert(job);
						assert(!["dead", "failed"].includes(job.status), `capture ${job.status}: ${job.error}`);
						return job.status === "completed";
					}),
				"shutdown capture durable completion",
				20_000,
			);
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND content LIKE '%L4 shutdown transcript%'",
				[sweep.agentId],
				sessionLabels,
				"speaker_user_id",
			);
			sweep.assertRows(
				"memory_artifacts",
				"agent_id=? AND session_key=? AND source_kind='transcript'",
				[sweep.agentId, sessionKey],
				sessionLabels,
				"author_user_id",
			);
		});
		await sweep.check("documents", async () => {
			const doc = await sweep.post("/api/documents", {
				agentId: sweep.agentId,
				source_type: "text",
				title: "L4 classified document",
				content: "L4 document evidence is stored before deriving child memories.",
			});
			const documentId = text(doc.id);
			sweep.assertRows("documents", "id=?", [documentId], agentLabels, "author_user_id");
			await until(
				async () =>
					sweep.read((db) =>
						Boolean(db.query("SELECT memory_id FROM document_memories WHERE document_id=?").get(documentId)),
					),
				"document child memories",
				35_000,
			);
			for (const child of sweep.read((db) =>
				db
					.query<{ memory_id: string }, [string]>("SELECT memory_id FROM document_memories WHERE document_id=?")
					.all(documentId),
			))
				sweep.assertMemory(child.memory_id, agentLabels);
		});
		await sweep.check("file import", async () => {
			const form = new FormData();
			form.append(
				"files",
				new File(["# L4 file evidence\nThe uploaded file preserves author and classification."], "l4-evidence.md", {
					type: "text/markdown",
				}),
			);
			const response = await fetch(`${sweep.daemon.origin}/api/sources/import?agentId=${sweep.agentId}`, {
				method: "POST",
				headers: { cookie: sweep.credential.cookie ?? "", "x-signet-csrf": sweep.credential.csrf ?? "" },
				body: form,
				signal: AbortSignal.timeout(30_000),
			});
			const body: unknown = await response.json();
			assert(response.ok, JSON.stringify(body));
			assert.equal(record(body).failed, 0, JSON.stringify(body));
			sweep.assertRows(
				"memory_artifacts",
				"agent_id=? AND source_path LIKE '%l4-evidence%'",
				[sweep.agentId],
				agentLabels,
				"author_user_id",
			);
		});
		await sweep.check("transcript import", async () => {
			const job = await sweep.post(`/api/sources/imports?agentId=${sweep.agentId}`, {
				files: [{ name: "l4-transcript.jsonl" }],
			});
			assert(Array.isArray(job.files));
			const path = `/api/sources/imports/${text(job.jobId)}/files/${text(record(job.files[0]).id)}?agentId=${sweep.agentId}`;
			const data = `${JSON.stringify({
				id: "l4-import",
				source: "signet",
				harness: "codex",
				agent_id: sweep.agentId,
				session_key: "l4-import-session",
				project: null,
				timestamp: "2026-11-25T12:00:00.000Z",
				message_count: 2,
				messages: [
					{ role: "user", content: "L4 imported transcript evidence." },
					{ role: "assistant", content: "L4 imported reply." },
				],
			})}\n`;
			const uploaded = await fetch(`${sweep.daemon.origin}${path}`, {
				method: "PUT",
				headers: {
					cookie: sweep.credential.cookie ?? "",
					"x-signet-csrf": sweep.credential.csrf ?? "",
					"upload-length": String(Buffer.byteLength(data)),
					"content-type": "application/octet-stream",
				},
				body: data,
				signal: AbortSignal.timeout(30_000),
			});
			assert(uploaded.ok, `upload ${uploaded.status} ${await uploaded.text()}`);
			await sweep.post(`/api/sources/imports/${text(job.jobId)}/start?agentId=${sweep.agentId}`, {});
			try {
				await until(
					async () =>
						sweep.read((db) =>
							Boolean(
								db
									.query(
										"SELECT session_key FROM session_transcripts WHERE agent_id=? AND source_id IS NOT NULL AND content LIKE '%L4 imported transcript%'",
									)
									.get(sweep.agentId),
							),
						),
					"imported transcript",
					20_000,
				);
			} catch (error) {
				throw new Error(
					`${String(error)}; ${JSON.stringify(sweep.read((db) => ({ job: db.query("SELECT * FROM source_import_jobs WHERE id=?").get(text(job.jobId)), records: db.query("SELECT * FROM source_import_records WHERE job_id=?").all(text(job.jobId)) })))}`,
				);
			}
			sweep.assertRows(
				"session_transcripts",
				"agent_id=? AND content LIKE '%L4 imported transcript%'",
				[sweep.agentId],
				agentLabels,
				"speaker_user_id",
			);
		});
		await sweep.check("local folder source sync", async () => {
			const root = join(sweep.daemon.root, "vault");
			await mkdir(root);
			await writeFile(
				join(root, "l4-source.md"),
				"# L4 source evidence\nLocal folder content must preserve authenticated source ownership.",
			);
			const result = await sweep.post(`/api/sources/obsidian?agentId=${sweep.agentId}`, {
				root,
				name: "L4 folder",
				agentId: sweep.agentId,
			});
			const sourceId = text(record(result.source).id);
			assert.equal(sourceId, sweep.sourceId, "folder sync must use the classified source identity");
			await until(
				async () =>
					sweep.read((db) =>
						Boolean(db.query("SELECT source_path FROM memory_artifacts WHERE source_id=?").get(sourceId)),
					),
				"folder evidence",
				20_000,
			);
			sweep.assertRows(
				"memory_artifacts",
				"source_id=?",
				[sourceId],
				[...agentLabels, "cls_l4_source"],
				"author_user_id",
			);
		});
		await sweep.check("reflection answer", async () => {
			const result = await sweep.post(`/api/reflections/l4-reflection/answer?agentId=${sweep.agentId}`, {
				answer: "L4 reflection answer must inherit the classified reflection evidence.",
			});
			sweep.assertMemory(text(result.memoryId), sessionLabels);
		});
		await sweep.check("configured scheduled telemetry retention", async () => {
			const manual = await request(sweep.daemon.origin, "/api/repair/retention-sweep", sweep.credential, "POST", {
				agentId: sweep.agentId,
			});
			assert.equal(manual.status, 409);
			assert.equal(record(manual.body).reason, "tracked_job_required");
			await until(
				async () =>
					sweep.read((db) =>
						db.query("SELECT 1 FROM session_recall_events WHERE session_key='l4-expired-telemetry'").get(),
					) === null,
				"scheduled retention deletes expired telemetry",
				70_000,
			);
			assert.equal(
				sweep.read((db) =>
					db.query("SELECT 1 FROM session_recall_events WHERE session_key='l4-expired-telemetry'").get(),
				),
				null,
			);
			assert.equal(
				sweep.read((db) =>
					db
						.query("SELECT 1 FROM evidence_citations WHERE derived_kind='telemetry' AND derived_id=?")
						.get(JSON.stringify(["l4-expired-telemetry", 0, "memory", "l4-retention-parent"])),
				),
				null,
			);
			assert(sweep.read((db) => db.query("SELECT 1 FROM memories WHERE id='l4-retention-parent'").get()));
		});
		await sweep.check("all persisted evidence children", async () => {
			sweep.assertAllChildren();
		});
		await sweep.check("legitimate writes avoid compartment guards", async () => {
			assert(
				!/compartment_required/.test(sweep.daemon.stdout + sweep.daemon.stderr),
				"legitimate evidence writes hit compartment guard",
			);
		});
		console.log(JSON.stringify({ runtime: Bun.version, passed: sweep.results, failures: sweep.failures }));
		assert.deepEqual(sweep.failures, []);
	} finally {
		await sweep.dispose();
	}
}, 180_000);
