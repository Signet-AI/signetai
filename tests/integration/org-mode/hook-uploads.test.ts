import "../../support/connector-safety.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, text, until } from "./http";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function stage(
	daemon: OrgDaemon,
	user: ReturnType<Fixture["user"]>,
	sessionKey: string,
	bytes: Buffer,
): Promise<string> {
	const declaration = success(
		await request(daemon.origin, "/api/hooks/session-end/uploads", user.connector, "POST", {
			sessionKey,
			harness: "codex",
			totalBytes: bytes.length,
			sha256: digest(bytes),
		}),
		"POST /api/hooks/session-end/uploads",
	);
	const uploadId = text(declaration.uploadId);
	const chunkBytes = declaration.chunkBytes;
	assert(typeof chunkBytes === "number" && Number.isSafeInteger(chunkBytes));
	assert(chunkBytes > 0 && chunkBytes <= 1024 * 1024, "Upload chunks must be bounded to 1 MiB");
	assert.equal(declaration.receivedBytes, 0);
	assert(user.connector.bearer);
	for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
		const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
		const response: Response = await fetch(
			`${daemon.origin}/api/hooks/session-end/uploads/${encodeURIComponent(uploadId)}`,
			{
				method: "PATCH",
				headers: {
					authorization: `Bearer ${user.connector.bearer}`,
					"content-type": "application/octet-stream",
					"upload-offset": String(offset),
					"upload-checksum": digest(chunk),
				},
				body: new Uint8Array(chunk),
				signal: AbortSignal.timeout(30_000),
			},
		);
		assert.equal(response.status, 200, "PATCH must durably accept each bounded chunk");
		assert.equal(record(await response.json()).receivedBytes, offset + chunk.length);
	}
	return uploadId;
}

test("A21 delivers a 10 MiB staged session-end with byte-exact evidence", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon);
		const user = fixture.user("alice");
		const sessionKey = "a21-large-transcript";
		const bytes = Buffer.alloc(
			10 * 1024 * 1024,
			"User: the staged transcript preserves each byte.\nAssistant: acknowledged.\n",
		);
		const uploadId = await stage(daemon, user, sessionKey, bytes);
		const ended = success(
			await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", {
				harness: "codex",
				sessionKey,
				reason: "session_shutdown",
				transcriptUpload: { uploadId },
				lastAssistantMessage: "Fallback reply must not supplement uploaded evidence.",
			}),
			"POST /api/hooks/session-end",
		);
		assert.equal(ended.queued, true);
		await daemon.restart();
		const repeats = await Promise.all(
			[0, 1].map(() =>
				request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", {
					harness: "codex",
					sessionKey,
					reason: "session_shutdown",
					transcriptUpload: { uploadId },
				}),
			),
		);
		for (const repeated of repeats) assert.deepEqual(success(repeated, "replayed session-end"), ended);

		let evidence: Buffer | undefined;
		await until(
			async () => {
				const reply = await request(
					daemon.origin,
					`/api/sessions/${sessionKey}/transcript?agent_id=${encodeURIComponent(user.agentId)}`,
					user.session,
				);
				if (reply.status !== 200) return false;
				evidence = Buffer.from(text(record(reply.body).content));
				return evidence.length === bytes.length;
			},
			"A21 evidence readback",
			60_000,
		);
		assert(evidence);
		assert.equal(digest(evidence), digest(bytes), "Persisted evidence must match the complete transcript hash");
		assert(evidence.equals(bytes), "Persisted evidence must match every original byte");
	} catch (error) {
		const diagnostic = `${daemon.stdout}
${daemon.stderr}`
			.split("\n")
			.filter((line) => /Session end hook failed|Transcript capture|DB owner|Unknown.*request|Error:/.test(line))
			.join("\n")
			.replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostic}`, { cause: error });
	} finally {
		await daemon.dispose();
	}
}, 180_000);

test("A21 receipt publication failure rolls back capture admission", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon),
			user = fixture.user("alice");
		const sessionKey = "a21-atomic-receipt";
		const id = await stage(daemon, user, sessionKey, Buffer.from("User: atomic upload\nAssistant: retained\n"));
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			db.exec(
				"CREATE TRIGGER reject_upload_receipt BEFORE UPDATE OF result_json ON hook_transcript_uploads WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt publication rejected'); END",
			);
		} finally {
			db.close();
		}
		await daemon.start();
		const input = { harness: "codex", sessionKey, reason: "session_shutdown", transcriptUpload: { uploadId: id } };
		assert.equal((await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", input)).status, 500);
		await daemon.stop();
		const after = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			assert.deepEqual(
				after
					.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs WHERE agent_id = ? AND session_key = ?")
					.get(user.agentId, sessionKey),
				{ count: 0 },
			);
			assert.deepEqual(
				after.prepare("SELECT storage_state,result_json FROM hook_transcript_uploads WHERE id = ?").get(id),
				{ storage_state: "sealed", result_json: null },
			);
			after.exec("DROP TRIGGER reject_upload_receipt");
		} finally {
			after.close();
		}
		await daemon.start();
		const deliveries = await Promise.all(
			[0, 1].map(() => request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", input)),
		);
		const first = deliveries[0];
		assert(first);
		const accepted = success(first, "recovered session-end");
		for (const reply of deliveries) assert.deepEqual(success(reply, "concurrent session-end"), accepted);
		assert.equal(accepted.queued, true);
		assert.deepEqual(
			success(
				await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", input),
				"replayed session-end",
			),
			accepted,
		);
		await until(
			async () =>
				(
					await request(
						daemon.origin,
						`/api/sessions/${sessionKey}/transcript?agent_id=${encodeURIComponent(user.agentId)}`,
						user.session,
					)
				).status === 200,
			"captured upload before deletion",
			60_000,
		);
		const deleted = success(
			await request(
				daemon.origin,
				`/api/sessions/${sessionKey}/transcript?agent_id=${encodeURIComponent(user.agentId)}`,
				user.session,
				"DELETE",
			),
			"delete staged transcript evidence",
		);
		if (deleted.status !== "complete")
			await until(
				async () => {
					const next = success(
						await request(
							daemon.origin,
							`/api/sessions/${sessionKey}/transcript?agent_id=${encodeURIComponent(user.agentId)}&generation=${deleted.generation}`,
							user.session,
							"DELETE",
						),
						"resume transcript deletion",
					);
					return next.status === "complete";
				},
				"staged transcript deletion",
				60_000,
			);
		assert.equal((await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, user.connector)).status, 404);
		await daemon.stop();
		const purged = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
		try {
			assert.deepEqual(
				purged.prepare("SELECT COUNT(*) AS count FROM hook_transcript_chunks WHERE file_id = ?").get(id),
				{ count: 0 },
			);
		} finally {
			purged.close();
		}
	} finally {
		await daemon.dispose();
	}
}, 180_000);
test("A21 session-end has foreign-principal 404 parity", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon),
			alice = fixture.user("alice"),
			bob = fixture.user("bob");
		const sessionKey = "a21-foreign-finalization";
		const id = await stage(
			daemon,
			alice,
			sessionKey,
			Buffer.from("User: private staged evidence\nAssistant: protected\n"),
		);
		for (const uploadId of [id, crypto.randomUUID()]) {
			const reply = await request(daemon.origin, "/api/hooks/session-end", bob.connector, "POST", {
				harness: "codex",
				sessionKey,
				reason: "session_shutdown",
				transcriptUpload: { uploadId },
			});
			assert.equal(reply.status, 404);
			assert.deepEqual(reply.body, { error: "Upload not found" });
		}
	} finally {
		await daemon.dispose();
	}
}, 180_000);

function uploadStorageRow(daemon: OrgDaemon, sql: string) {
	const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
	try {
		return record(db.prepare(sql).get());
	} finally {
		db.close();
	}
}

test("A21 six completed finalizations release storage and expire their receipts", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon),
			user = fixture.user("alice");
		const baseline = uploadStorageRow(daemon, "SELECT reserved_bytes FROM source_import_capacity WHERE id = 1");
		await daemon.stop();
		const observation = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			observation.exec(`CREATE TABLE consumed_reservations (reserved_bytes INTEGER,stored_bytes INTEGER);
 CREATE TRIGGER observe_consumption AFTER UPDATE OF storage_state ON hook_transcript_uploads WHEN NEW.storage_state = 'consumed' AND OLD.storage_state <> 'consumed' BEGIN INSERT INTO consumed_reservations VALUES (NEW.reserved_bytes,(SELECT COALESCE(SUM(length(content)),0) FROM hook_transcript_chunks WHERE file_id = NEW.id AND agent_id = NEW.agent_id)); END;`);
		} finally {
			observation.close();
		}
		await daemon.start();
		const deliveries: Array<{
			input: { harness: string; sessionKey: string; reason: string; transcriptUpload: { uploadId: string } };
			result: Record<string, unknown>;
		}> = [];
		for (let index = 0; index < 6; index++) {
			const sessionKey = `capacity-release-${index}`;
			const uploadId = await stage(
				daemon,
				user,
				sessionKey,
				Buffer.from(`User: durable evidence ${index}\nAssistant: retained\n`),
			);
			const input = { harness: "codex", sessionKey, reason: "session_shutdown", transcriptUpload: { uploadId } };
			const result = success(
				await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", input),
				"finalize capacity upload",
			);
			assert.equal(result.queued, true);
			deliveries.push({ input, result });
		}
		await until(
			async () =>
				uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM transcript_capture_jobs WHERE status = 'completed'")
					.count === 6,
			"six completed capture jobs",
			60000,
		);
		assert.deepEqual(
			uploadStorageRow(daemon, "SELECT reserved_bytes FROM source_import_capacity WHERE id = 1"),
			baseline,
			"completed captures must release shared capacity",
		);
		assert.deepEqual(
			uploadStorageRow(
				daemon,
				"SELECT COUNT(*) AS count FROM consumed_reservations WHERE reserved_bytes <> stored_bytes",
			),
			{ count: 0 },
			"consumption retains only actually stored bytes",
		);
		assert.deepEqual(uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM hook_transcript_chunks"), { count: 0 });
		assert.deepEqual(uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM hook_transcript_uploads"), { count: 0 });
		assert.deepEqual(uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM hook_transcript_receipts"), { count: 6 });
		for (const delivery of deliveries)
			assert.deepEqual(
				success(
					await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", delivery.input),
					"replay completed receipt",
				),
				delivery.result,
			);
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			db.exec("UPDATE hook_transcript_receipts SET consumed_at = datetime('now','-8 days')");
		} finally {
			db.close();
		}
		await daemon.start();
		const first = deliveries[0];
		assert(first);
		assert.equal(
			(await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", first.input)).status,
			404,
		);
		assert.deepEqual(uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM hook_transcript_receipts"), { count: 0 });
	} finally {
		await daemon.dispose();
	}
}, 180000);

test("A21 terminal capture failure releases staged storage and persists failure", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon),
			user = fixture.user("alice");
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			db.exec(`CREATE TRIGGER one_capture_attempt AFTER INSERT ON transcript_capture_jobs BEGIN UPDATE transcript_capture_jobs SET max_attempts = 1 WHERE id = NEW.id; END;
 CREATE TRIGGER reject_capture_completion BEFORE UPDATE OF status ON transcript_capture_jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT,'capture completion rejected'); END;`);
		} finally {
			db.close();
		}
		await daemon.start();
		const uploadId = await stage(
			daemon,
			user,
			"terminal-capture",
			Buffer.from("User: terminal failure evidence\nAssistant: retained\n"),
		);
		const input = {
			harness: "codex",
			sessionKey: "terminal-capture",
			reason: "session_shutdown",
			transcriptUpload: { uploadId },
		};
		success(
			await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", input),
			"admit failing capture",
		);
		await until(
			async () =>
				uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM transcript_capture_jobs WHERE status = 'dead'")
					.count === 1,
			"terminal capture failure",
			60000,
		);
		assert.deepEqual(
			uploadStorageRow(daemon, "SELECT reserved_bytes FROM source_import_capacity WHERE id = 1"),
			{ reserved_bytes: 0 },
			"terminal failures must release shared capacity",
		);
		assert.deepEqual(uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM hook_transcript_chunks"), { count: 0 });
		assert.deepEqual(uploadStorageRow(daemon, "SELECT COUNT(*) AS count FROM hook_transcript_uploads"), { count: 0 });
		const replay = success(
			await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", input),
			"replay terminal receipt",
		);
		assert.equal(replay.queued, false);
		assert.equal(replay.captureFailed, true);
	} finally {
		await daemon.dispose();
	}
}, 180000);
