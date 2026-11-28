import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { device, Fixture } from "./fixture";
import { record, request, success, text, until } from "./http";

test.each(["document", "transcript"] as const)(
	"reclassified %s imports do not reveal their old public identity",
	async (kind) => {
		const daemon = await OrgDaemon.create();
		let snapshot: Database | undefined;
		try {
			const fixture = await Fixture.create(daemon, "single", false);
			snapshot = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			const database = snapshot;
			const upload = async (name: "carol" | "alice") => {
				const credential = fixture.user(name).session;
				const bearer = text(credential.bearer);
				if (kind === "transcript") {
					const job = success(
						await request(daemon.origin, "/api/sources/imports", credential, "POST", {
							files: [{ name: "reclassified.jsonl" }],
						}),
						"create transcript import",
					);
					if (!Array.isArray(job.files)) throw new Error("missing import files");
					const response = await fetch(
						`${daemon.origin}/api/sources/imports/${text(job.id)}/files/${text(record(job.files[0]).id)}`,
						{
							method: "PUT",
							headers: { authorization: `Bearer ${bearer}` },
							body: `${JSON.stringify({ source: "signet", id: "reclassified", harness: "codex", agent_id: "foreign", session_key: "reclassified", project: null, timestamp: "2026-01-01T00:00:00Z", message_count: 1, messages: [{ role: "user", content: "Reclassification source identity probe." }] })}\n`,
							signal: AbortSignal.timeout(30_000),
						},
					);
					const body = record(await response.json());
					if (response.status === 201) {
						success(
							await request(daemon.origin, `/api/sources/imports/${text(job.id)}/start`, credential, "POST", {}),
							"start transcript import",
						);
						await until(
							async () => {
								const state = record(
									database.query("SELECT state,error FROM source_import_jobs WHERE id=?").get(text(job.id)),
								);
								expect(state.state, String(state.error)).not.toBe("failed");
								expect(state.state, String(state.error)).not.toBe("completed_with_rejections");
								return state.state === "completed";
							},
							"transcript import completes",
							45_000,
						);
					}
					return { status: response.status, body: { files: [body] } };
				}
				const form = new FormData();
				form.set(
					"files",
					new File(["Reclassification source identity probe."], "reclassified.md", { type: "text/markdown" }),
				);
				const response = await fetch(`${daemon.origin}/api/sources/import`, {
					method: "POST",
					headers: { authorization: `Bearer ${bearer}` },
					body: form,
					signal: AbortSignal.timeout(30_000),
				});
				return { status: response.status, body: record(await response.json()) };
			};
			const first = await upload("carol");
			expect(first.status).toBe(201);
			if (!Array.isArray(first.body.files)) throw new Error("missing imported files");
			const sourceId = text(record(first.body.files[0]).sourceId);
			await fixture.classify("source", sourceId, "default");
			expect(
				database
					.query(
						"SELECT cm.classification_id FROM import_content_registry r JOIN compartment_members cm ON cm.compartment_id=r.compartment_id WHERE r.agent_id='default' AND r.source_id=?",
					)
					.all(sourceId),
			).toEqual([{ classification_id: fixture.hrId }]);
			await daemon.stop();
			await daemon.start();
			const outsider = await upload("alice");
			expect(outsider.status, JSON.stringify(outsider.body)).toBe(201);
			if (!Array.isArray(outsider.body.files)) throw new Error("missing imported files");
			const outsiderId = text(record(outsider.body.files[0]).sourceId);
			expect(outsiderId).not.toBe(sourceId);
			const repeat = await upload("alice");
			expect(repeat.status).toBe(201);
			if (!Array.isArray(repeat.body.files)) throw new Error("missing imported files");
			expect(record(repeat.body.files[0]).sourceId).toBe(outsiderId);
			success(
				await request(
					daemon.origin,
					`/api/classifications/${fixture.hrId}/remove?wait=1`,
					fixture.user("cora").session,
					"POST",
					{ target: { kind: "source", id: sourceId, agentId: "default" } },
				),
				"remove source classification",
			);
			expect(
				database.query("SELECT source_id,compartment_id FROM import_content_registry WHERE source_id=?").get(sourceId),
			).toEqual({ source_id: sourceId, compartment_id: null });
			await fixture.classify("source", sourceId, "default");
			const purged = await request(
				daemon.origin,
				`/api/sources/${encodeURIComponent(sourceId)}`,
				fixture.user("audra").session,
				"DELETE",
			);
			expect(purged.status, JSON.stringify(purged.body)).toBe(200);
			for (const table of ["import_content_registry", "source_import_files", "memory_artifacts", "session_transcripts"])
				expect(database.query(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id=?`).get(sourceId)).toEqual({ n: 0 });
			expect(database.query("SELECT source_id FROM import_content_registry WHERE source_id=?").get(outsiderId)).toEqual(
				{ source_id: outsiderId },
			);
			const retained = success(
				await request(daemon.origin, "/api/sources", fixture.user("alice").session),
				"remaining sources",
			);
			expect(JSON.stringify(retained)).toContain(outsiderId);
			expect(JSON.stringify(retained)).not.toContain(sourceId);
		} finally {
			snapshot?.close();
			await daemon.dispose();
		}
	},
	120_000,
);

test("different destination labels do not share truncated source identities", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "single", false);
		const author = fixture.user("carol"),
			outsider = fixture.user("alice");
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			for (const [classificationId, userId] of [
				["cls_collision_27213", author.id],
				["cls_collision_48862", outsider.id],
			]) {
				db.query("INSERT INTO classifications(id,name,created_at) VALUES(?,?,?)").run(
					classificationId,
					classificationId,
					"2026",
				);
				db.query(
					"INSERT INTO classification_audience(classification_id,principal_kind,principal_id) VALUES(?,'user',?)",
				).run(classificationId, userId);
			}
		} finally {
			db.close();
		}
		await daemon.start();
		for (const [classificationId, bearer] of [
			["cls_collision_27213", text(author.session.bearer)],
			["cls_collision_48862", text(outsider.session.bearer)],
		]) {
			const form = new FormData();
			form.set("files", new File(["source identity collision probe"], "collision.md", { type: "text/markdown" }));
			form.set("classificationId", classificationId);
			const response = await fetch(`${daemon.origin}/api/sources/import`, {
				method: "POST",
				headers: { authorization: `Bearer ${bearer}` },
				body: form,
				signal: AbortSignal.timeout(30_000),
			});
			expect(response.status, await response.text()).toBe(201);
		}
	} finally {
		await daemon.dispose();
	}
}, 120_000);

test("same import bytes do not probe another author's hidden label set", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "single", false);
		const carol = fixture.user("carol");
		const alice = fixture.user("alice");
		let hiddenCanonicalId: string | undefined;
		let oracleCanonicalId: string | undefined;
		const transcript = async (bearer: string, classificationId?: string, content = "confidential oracle") => {
			const created = success(
				await request(daemon.origin, "/api/sources/imports", { bearer }, "POST", {
					classificationId,
					files: [{ name: "oracle.jsonl" }],
				}),
				"create oracle import",
			);
			if (!Array.isArray(created.files)) throw new Error("missing files");
			const response = await fetch(
				`${daemon.origin}/api/sources/imports/${text(created.id)}/files/${text(record(created.files[0]).id)}`,
				{
					method: "PUT",
					headers: { authorization: `Bearer ${bearer}`, "content-type": "application/octet-stream" },
					body: `${JSON.stringify({ source: "signet", id: "oracle", agent_id: "foreign", harness: "codex", session_key: "oracle", project: null, timestamp: "2026-01-01T00:00:00Z", message_count: 1, messages: [{ role: "user", content }] })}\n`,
					signal: AbortSignal.timeout(30_000),
				},
			);
			const body = record(await response.json());
			if (response.status === 201) {
				success(
					await request(daemon.origin, `/api/sources/imports/${text(created.id)}/start`, { bearer }, "POST", {}),
					"start oracle import",
				);
				const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
				try {
					await until(
						async () => {
							const state = record(
								db.query("SELECT state,error FROM source_import_jobs WHERE id=?").get(text(created.id)),
							);
							expect(state.state, String(state.error)).not.toBe("failed");
							return state.state === "completed" || state.state === "completed_with_rejections";
						},
						"oracle job completes",
						45_000,
					);
					const rows = db
						.query("SELECT status,canonical_id,canonical_key,rejection_code FROM source_import_records WHERE job_id=?")
						.all(text(created.id));
					expect(rows).toHaveLength(1);
					if (content !== "confidential oracle") {
						expect(record(rows[0]).status).toBe("rejected");
						expect(record(rows[0]).rejection_code).toBe("conversation_identity_conflict");
						expect(record(rows[0]).canonical_id).toBe(oracleCanonicalId);
						return { status: response.status, body };
					}
					expect(record(rows[0]).status).toBe(
						bearer === text(alice.session.bearer) && oracleCanonicalId !== undefined ? "duplicate" : "imported",
					);
					if (bearer === text(carol.session.bearer)) hiddenCanonicalId = text(record(rows[0]).canonical_id);
					else {
						expect(record(rows[0]).canonical_id).not.toBe(hiddenCanonicalId);
						oracleCanonicalId = text(record(rows[0]).canonical_id);
					}
					const stored = record(
						db
							.query("SELECT source_id,speaker_user_id FROM session_transcripts WHERE session_key=?")
							.get(text(record(rows[0]).canonical_key)),
					);
					expect(stored.source_id).toBe(body.sourceId);
				} finally {
					db.close();
				}
			}
			return { status: response.status, body };
		};
		const document = async (bearer: string, classificationId?: string) => {
			const form = new FormData();
			form.set("files", new File(["confidential oracle document"], "oracle.md", { type: "text/markdown" }));
			if (classificationId) form.set("classificationId", classificationId);
			const response = await fetch(`${daemon.origin}/api/sources/import`, {
				method: "POST",
				headers: { authorization: `Bearer ${bearer}` },
				body: form,
				signal: AbortSignal.timeout(30_000),
			});
			return { status: response.status, body: record(await response.json()) };
		};
		for (const upload of [transcript, document]) {
			const hidden = await upload(text(carol.session.bearer), fixture.hrId);
			expect(hidden.status, JSON.stringify(hidden.body)).toBe(201);
			const ownConflict = await upload(text(carol.session.bearer));
			expect(ownConflict.status).toBe(409);
			const outsider = await upload(text(alice.session.bearer));
			expect(outsider.status, JSON.stringify(outsider.body)).toBe(201);
			if (upload === transcript)
				expect((await transcript(text(alice.session.bearer), undefined, "changed readable conversation")).status).toBe(
					201,
				);
			const repeat = await upload(text(alice.session.bearer));
			expect(repeat.status).toBe(201);
			const source = (body: Record<string, unknown>) =>
				Array.isArray(body.files) ? record(body.files[0]).sourceId : body.sourceId;
			expect(source(repeat.body)).toBe(source(outsider.body));
			expect(source(outsider.body)).not.toBe(source(hidden.body));
		}
	} finally {
		await daemon.dispose();
	}
}, 120_000);

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
		expect(
			(
				await request(
					daemon.origin,
					`/api/sources/${encodeURIComponent(documentSource)}${agentQuery}`,
					fixture.user("audra").session,
					"DELETE",
				)
			).status,
		).toBe(403);
		success(
			await request(daemon.origin, `/api/org/users/${author.id}`, fixture.admin, "PATCH", { role: "admin" }),
			"authorize source owner to manage connectors",
		);
		expect(
			(await request(daemon.origin, `/api/sources/${encodeURIComponent(documentSource)}`, author.session, "DELETE"))
				.status,
		).toBe(403);
		const operator = await device(daemon, author.browser, "source-operator");
		success(
			await request(
				daemon.origin,
				`/api/sources/${encodeURIComponent(documentSource)}${agentQuery}`,
				operator.credential,
				"DELETE",
			),
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
