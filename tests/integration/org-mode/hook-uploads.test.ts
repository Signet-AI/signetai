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
				return true;
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
