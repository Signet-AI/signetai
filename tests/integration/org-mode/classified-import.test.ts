import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, text, until } from "./http";

test("classified imports stay hidden from admission through worker completion", async () => {
	const daemon = await OrgDaemon.create();
	let snapshot: Database | undefined;
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const author = fixture.user("carol");
		const outsider = fixture.user("alice");
		const agentQuery = `?agentId=${encodeURIComponent(author.agentId)}`;
		snapshot = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
		const before = snapshot.query("SELECT COUNT(*) AS n FROM source_import_jobs").get();
		const denied = await request(daemon.origin, "/api/sources/imports", outsider.session, "POST", {
			classificationId: fixture.hrId,
			files: [{ name: "never-written.jsonl" }],
		});
		expect(denied.status).toBe(403);
		expect(snapshot.query("SELECT COUNT(*) AS n FROM source_import_jobs").get()).toEqual(before);
		const create = async (classificationId?: string) =>
			success(
				await request(daemon.origin, "/api/sources/imports", author.session, "POST", {
					classificationId,
					files: [{ name: "confidential.jsonl" }],
				}),
				"create classified import",
			);
		const job = await create(fixture.hrId);
		const jobId = text(job.id);
		const files = job.files;
		expect(Array.isArray(files)).toBe(true);
		if (!Array.isArray(files)) throw new Error("missing import files");
		const fileId = text(record(files[0]).id);
		expect(snapshot.query("SELECT labels_json FROM source_import_jobs WHERE id=?").get(jobId)).toEqual({
			labels_json: JSON.stringify([fixture.hrId]),
		});
		const assertInvisible = async () => {
			const listing = await request(daemon.origin, `/api/sources/imports${agentQuery}`, outsider.session);
			expect(listing.status).toBe(200);
			expect(JSON.stringify(listing.body)).not.toContain(jobId);
			const exported = await request(
				daemon.origin,
				`/api/sources/imports/export/transcripts${agentQuery}&limit=1000`,
				outsider.session,
			);
			expect(exported.status).toBe(200);
			expect(JSON.stringify(exported.body)).not.toContain("importHRconfidential");
		};
		await assertInvisible();
		const payload =
			Array.from({ length: 320 }, (_, index) =>
				JSON.stringify({
					source: "signet",
					id: `atomic-import-${index}`,
					harness: "codex",
					agent_id: "original-agent",
					session_key: `atomic-import-${index}`,
					project: "import-proof",
					timestamp: "2026-01-01T00:00:00Z",
					message_count: 1,
					messages: [{ role: "user", content: `importHRconfidential ${index}` }],
				}),
			).join("\n") + "\n";
		const upload = async (created: Record<string, unknown>) => {
			if (!Array.isArray(created.files)) throw new Error("missing files");
			const response = await fetch(
				`${daemon.origin}/api/sources/imports/${text(created.id)}/files/${text(record(created.files[0]).id)}`,
				{
					method: "PUT",
					headers: {
						authorization: `Bearer ${text(author.session.bearer)}`,
						"upload-length": String(Buffer.byteLength(payload)),
						"content-type": "application/octet-stream",
					},
					body: payload,
					signal: AbortSignal.timeout(30_000),
				},
			);
			return { status: response.status, body: record(await response.json()) };
		};
		const uploaded = await upload(job);
		expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
		const sourceId = text(uploaded.body.sourceId);
		expect(
			snapshot
				.query(
					"SELECT classification_id FROM classification_assignments WHERE target_kind='source' AND target_id=? AND agent_id=?",
				)
				.all(sourceId, author.agentId),
		).toEqual([{ classification_id: fixture.hrId }]);
		expect(
			snapshot.query("SELECT source_id FROM source_import_files WHERE job_id=? AND id=?").get(jobId, fileId),
		).toEqual({ source_id: sourceId });
		await assertInvisible();
		const conflicted = await upload(await create());
		expect(conflicted).toMatchObject({ status: 409, body: { reason: "import_classification_conflict" } });
		const repeated = await upload(await create(fixture.hrId));
		expect(repeated).toMatchObject({ status: 201, body: { sourceId } });
		success(
			await request(daemon.origin, `/api/sources/imports/${jobId}/start`, author.session, "POST", {}),
			"start classified import",
		);
		let polls = 0;
		await until(
			async () => {
				await assertInvisible();
				polls++;
				if (!snapshot) throw new Error("missing snapshot");
				expect(
					snapshot
						.query(
							"SELECT COUNT(*) AS n FROM session_transcripts t WHERE t.source_id=? AND t.agent_id=? AND NOT EXISTS (SELECT 1 FROM compartment_members m WHERE m.compartment_id=t.compartment_id AND m.classification_id=?)",
						)
						.get(sourceId, author.agentId, fixture.hrId),
				).toEqual({ n: 0 });
				const state = record(snapshot.query("SELECT state,error FROM source_import_jobs WHERE id=?").get(jobId));
				expect(state.state, String(state.error)).not.toBe("failed");
				return state.state === "completed";
			},
			"classified import completes without an unlabeled snapshot",
			45_000,
		);
		expect(polls).toBeGreaterThan(0);
		const material = success(
			await request(daemon.origin, `/api/classifications/${fixture.hrId}/items`, author.session),
			"enumerate imported classified material",
		);
		expect(material.items).toContainEqual({ target_kind: "source", target_id: sourceId, agent_id: author.agentId });
		expect((await request(daemon.origin, `/api/classifications/${fixture.hrId}/items`, outsider.session)).status).toBe(
			404,
		);
		expect(
			snapshot
				.query("SELECT COUNT(*) AS n FROM session_transcripts WHERE source_id=? AND agent_id=?")
				.get(sourceId, author.agentId),
		).toEqual({ n: 320 });
		await assertInvisible();
		const form = (classificationId?: string) => {
			const value = new FormData();
			value.set(
				"files",
				new File(["importHRdocument confidential retention award"], "hr-import.md", { type: "text/markdown" }),
			);
			if (classificationId) value.set("classificationId", classificationId);
			return value;
		};
		const document = async (bearer: string, classificationId?: string) => {
			const response = await fetch(`${daemon.origin}/api/sources/import`, {
				method: "POST",
				headers: { authorization: `Bearer ${bearer}` },
				body: form(classificationId),
				signal: AbortSignal.timeout(30_000),
			});
			return { status: response.status, body: record(await response.json()) };
		};
		const documentsBefore = snapshot.query("SELECT COUNT(*) AS n FROM document_import_jobs").get();
		expect((await document(text(outsider.session.bearer), fixture.hrId)).status).toBe(403);
		expect(snapshot.query("SELECT COUNT(*) AS n FROM document_import_jobs").get()).toEqual(documentsBefore);
		const imported = await document(text(author.session.bearer), fixture.hrId);
		expect(imported.status, JSON.stringify(imported.body)).toBe(201);
		if (!Array.isArray(imported.body.files)) throw new Error("missing document result");
		const documentSource = text(record(imported.body.files[0]).sourceId);
		expect(
			snapshot
				.query(
					"SELECT COUNT(*) AS n FROM memory_artifacts a WHERE a.source_id=? AND NOT EXISTS (SELECT 1 FROM compartment_members m WHERE m.compartment_id=a.compartment_id AND m.classification_id=?)",
				)
				.get(documentSource, fixture.hrId),
		).toEqual({ n: 0 });
		expect(
			snapshot.query("SELECT COUNT(*) AS n FROM memory_artifacts WHERE source_id=?").get(documentSource),
		).not.toEqual({ n: 0 });
		expect((await document(text(author.session.bearer))).status).toBe(409);
		expect((await document(text(author.session.bearer), fixture.hrId)).status).toBe(201);
		const sourceListing = await request(daemon.origin, `/api/sources${agentQuery}`, outsider.session);
		expect(sourceListing.status).toBe(200);
		expect(JSON.stringify(sourceListing.body)).not.toContain(documentSource);
		const authorListing = await request(daemon.origin, `/api/sources${agentQuery}`, author.session);
		expect(authorListing.status).toBe(200);
		expect(JSON.stringify(authorListing.body)).toContain(documentSource);
		success(
			await request(daemon.origin, `/api/org/users/${author.id}`, fixture.admin, "PATCH", { role: "admin" }),
			"authorize source operator",
		);
		success(
			await request(daemon.origin, `/api/sources/${encodeURIComponent(documentSource)}`, author.session, "DELETE"),
			"purge classified document",
		);
		expect(
			snapshot.query("SELECT COUNT(*) AS n FROM document_import_jobs WHERE source_id=?").get(documentSource),
		).toEqual({ n: 0 });
		expect(snapshot.query("SELECT COUNT(*) AS n FROM memory_artifacts WHERE source_id=?").get(documentSource)).toEqual({
			n: 0,
		});
		expect(
			snapshot
				.query("SELECT COUNT(*) AS n FROM classification_assignments WHERE target_kind='source' AND target_id=?")
				.get(documentSource),
		).toEqual({ n: 0 });
	} finally {
		snapshot?.close();
		await daemon.dispose();
	}
}, 120_000);
