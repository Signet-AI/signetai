import "../../support/connector-safety.js";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { Fixture, type User } from "./fixture";
import { record, request, success, text } from "./http";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function withUpload(run: (daemon: OrgDaemon, fixture: Fixture) => Promise<void>): Promise<void> {
	const daemon = await OrgDaemon.create();
	try {
		await run(daemon, await Fixture.createIdentity(daemon));
	} finally {
		await daemon.dispose();
	}
}
async function declare(daemon: OrgDaemon, user: User, bytes: Uint8Array) {
	return success(
		await request(daemon.origin, "/api/hooks/session-end/uploads", user.connector, "POST", {
			sessionKey: "staging-contract",
			harness: "codex",
			totalBytes: bytes.length,
			sha256: digest(bytes),
		}),
		"POST hook upload",
	);
}
async function append(daemon: OrgDaemon, user: User, id: string, offset: number, bytes: Uint8Array): Promise<Response> {
	assert(user.connector.bearer);
	return fetch(`${daemon.origin}/api/hooks/session-end/uploads/${id}`, {
		method: "PATCH",
		headers: {
			authorization: `Bearer ${user.connector.bearer}`,
			"content-type": "application/octet-stream",
			"upload-offset": String(offset),
			"upload-checksum": digest(bytes),
		},
		body: new Uint8Array(bytes),
		signal: AbortSignal.timeout(30_000),
	});
}
test(
	"A21 staging preserves the server offset across daemon restart",
	() =>
		withUpload(async (daemon, fixture) => {
			const alice = fixture.user("alice"),
				bytes = Buffer.alloc(1024 * 1024 + 5, 65);
			const first = await declare(daemon, alice, bytes),
				id = text(first.uploadId);
			const uploaded = await append(daemon, alice, id, 0, bytes.subarray(0, 1024 * 1024));
			assert.equal(uploaded.status, 200);
			assert.equal(record(await uploaded.json()).receivedBytes, 1024 * 1024);
			await daemon.restart();
			const resumed = await declare(daemon, alice, bytes);
			assert.equal(resumed.uploadId, id);
			assert.equal(resumed.receivedBytes, 1024 * 1024);
			const state = success(
				await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, alice.connector),
				"GET hook upload",
			);
			assert.equal(state.receivedBytes, 1024 * 1024);
			const final = await append(daemon, alice, id, 1024 * 1024, bytes.subarray(1024 * 1024));
			assert.equal(final.status, 200);
			assert.equal(record(await final.json()).receivedBytes, bytes.length);
		}),
	180_000,
);

test(
	"A21 another principal gets absent-upload 404 parity",
	() =>
		withUpload(async (daemon, fixture) => {
			const alice = fixture.user("alice"),
				bob = fixture.user("bob"),
				bytes = Buffer.from("scoped staging bytes");
			const row = await declare(daemon, alice, bytes),
				id = text(row.uploadId);
			assert.equal((await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, alice.connector)).status, 200);
			const hidden = await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, bob.connector);
			const absent = await request(daemon.origin, "/api/hooks/session-end/uploads/missing-upload", bob.connector);
			assert.equal(hidden.status, 404);
			assert.equal(absent.status, 404);
			assert.deepEqual(hidden.body, absent.body);
			const denied = await append(daemon, bob, id, 0, bytes);
			assert.equal(denied.status, 404);
			await denied.arrayBuffer();
			const valid = await append(daemon, alice, id, 0, bytes);
			assert.equal(valid.status, 200);
			await valid.arrayBuffer();
		}),
	180_000,
);

test(
	"A21 expiry physically purges staged chunks",
	() =>
		withUpload(async (daemon, fixture) => {
			const alice = fixture.user("alice"),
				bytes = Buffer.alloc(64 * 1024, 65);
			const row = await declare(daemon, alice, bytes),
				id = text(row.uploadId);
			const uploaded = await append(daemon, alice, id, 0, bytes);
			assert.equal(uploaded.status, 200);
			await uploaded.arrayBuffer();
			await daemon.stop();
			const path = join(daemon.workspace, "data/signet.db");
			let db = new Database(path);
			try {
				assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_chunks WHERE file_id = ?").get(id), {
					count: 1,
				});
				db.prepare("UPDATE hook_transcript_uploads SET updated_at = datetime('now','-25 hours') WHERE id = ?").run(id);
			} finally {
				db.close();
			}
			await daemon.start();
			assert.equal((await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, alice.connector)).status, 404);
			await daemon.stop();
			db = new Database(path, { readonly: true });
			try {
				assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_chunks WHERE file_id = ?").get(id), {
					count: 0,
				});
				assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_uploads WHERE id = ?").get(id), {
					count: 0,
				});
			} finally {
				db.close();
			}
		}),
	180_000,
);

test(
	"A21 upload caller conflicts return typed offsets rather than 500",
	() =>
		withUpload(async (daemon, fixture) => {
			const user = fixture.user("alice"),
				bytes = Buffer.alloc(2 * 65536, 65);
			const row = await declare(daemon, user, bytes),
				id = text(row.uploadId);
			async function conflict(offset: number, chunk: Uint8Array, receivedBytes: number) {
				const response = await append(daemon, user, id, offset, chunk);
				assert.equal(response.status, 409);
				assert.deepEqual(record(await response.json()), {
					error: "Upload offset conflict",
					reason: "upload_offset_conflict",
					receivedBytes,
				});
			}
			await conflict(65536, bytes.subarray(65536), 0);
			const first = await append(daemon, user, id, 0, bytes.subarray(0, 65536));
			assert.equal(first.status, 200);
			await first.arrayBuffer();
			await conflict(0, bytes, 65536);
			await conflict(0, Buffer.alloc(65536, 66), 65536);
			const incomplete = await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", {
				harness: "codex",
				sessionKey: "staging-contract",
				reason: "session_shutdown",
				transcriptUpload: { uploadId: id },
			});
			assert.equal(incomplete.status, 409);
			assert.equal(record(incomplete.body).reason, "upload_incomplete");
		}),
	180000,
);

test(
	"A21 bad whole-file checksum releases storage and permits fresh declaration",
	() =>
		withUpload(async (daemon, fixture) => {
			const user = fixture.user("alice"),
				declared = Buffer.alloc(65536, 65);
			const first = await declare(daemon, user, declared),
				id = text(first.uploadId);
			const uploaded = await append(daemon, user, id, 0, Buffer.alloc(65536, 66));
			assert.equal(uploaded.status, 200);
			await uploaded.arrayBuffer();
			const failed = await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", {
				harness: "codex",
				sessionKey: "staging-contract",
				reason: "session_shutdown",
				transcriptUpload: { uploadId: id },
			});
			assert.equal(failed.status, 422);
			assert.equal(record(failed.body).reason, "upload_checksum_mismatch");
			assert.equal((await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, user.connector)).status, 404);
			const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			try {
				assert.deepEqual(db.prepare("SELECT reserved_bytes FROM source_import_capacity WHERE id=1").get(), {
					reserved_bytes: 0,
				});
				assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_chunks").get(), { count: 0 });
			} finally {
				db.close();
			}
			const fresh = await declare(daemon, user, declared);
			assert.notEqual(fresh.uploadId, id);
			assert.equal(fresh.receivedBytes, 0);
		}),
	180000,
);

test(
	"A21 abort obeys upload binding and releases staged bytes",
	() =>
		withUpload(async (daemon, fixture) => {
			const alice = fixture.user("alice"),
				bob = fixture.user("bob"),
				bytes = Buffer.alloc(65536, 65);
			const row = await declare(daemon, alice, bytes),
				id = text(row.uploadId);
			const uploaded = await append(daemon, alice, id, 0, bytes);
			assert.equal(uploaded.status, 200);
			await uploaded.arrayBuffer();
			const hidden = await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, bob.connector, "DELETE");
			const absent = await request(
				daemon.origin,
				"/api/hooks/session-end/uploads/missing-upload",
				bob.connector,
				"DELETE",
			);
			assert.equal(hidden.status, 404);
			assert.deepEqual(hidden.body, absent.body);
			const aborted = await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, alice.connector, "DELETE");
			assert.equal(aborted.status, 200);
			const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			try {
				assert.deepEqual(db.prepare("SELECT reserved_bytes FROM source_import_capacity WHERE id=1").get(), {
					reserved_bytes: 0,
				});
				assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_chunks").get(), { count: 0 });
			} finally {
				db.close();
			}
			assert.equal((await request(daemon.origin, `/api/hooks/session-end/uploads/${id}`, alice.connector)).status, 404);
			const fresh = await declare(daemon, alice, bytes);
			assert.notEqual(fresh.uploadId, id);
		}),
	180000,
);

test(
	"A21 hook upload cap is 256 MiB at declaration",
	() =>
		withUpload(async (daemon, fixture) => {
			const user = fixture.user("alice");
			const reply = await request(daemon.origin, "/api/hooks/session-end/uploads", user.connector, "POST", {
				harness: "codex",
				sessionKey: "oversized",
				totalBytes: 256 * 1024 * 1024 + 1,
				sha256: "a".repeat(64),
			});
			assert.equal(reply.status, 413);
		}),
	180000,
);

test(
	"A21 hook reservations contain declared bytes plus chunk overhead and cap open uploads at eight",
	() =>
		withUpload(async (daemon, fixture) => {
			const user = fixture.user("alice");
			for (let index = 0; index < 8; index++) await declare(daemon, user, Buffer.alloc(65536, index + 65));
			const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			try {
				assert.deepEqual(db.prepare("SELECT MIN(reserved_bytes) AS reservation FROM hook_transcript_uploads").get(), {
					reservation: 65536 + 4096,
				});
			} finally {
				db.close();
			}
			const ninth = await request(daemon.origin, "/api/hooks/session-end/uploads", user.connector, "POST", {
				harness: "codex",
				sessionKey: "ninth",
				totalBytes: 1,
				sha256: digest(Buffer.from("z")),
			});
			assert.equal(ninth.status, 503);
			assert.equal(record(ninth.body).reason, "busy");
		}),
	180000,
);

test(
	"A21 four slow PATCHes cannot monopolize another principal",
	() =>
		withUpload(async (daemon, fixture) => {
			const alice = fixture.user("alice"),
				bob = fixture.user("bob"),
				bytes = Buffer.from("a");
			const a = await declare(daemon, alice, bytes),
				b = await declare(daemon, bob, bytes);
			assert(alice.connector.bearer);
			const controllers: Array<AbortController> = [];
			const requests: Array<Promise<Response>> = [];
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				for (let index = 0; index < 5; index++) {
					const controller = new AbortController();
					controllers.push(controller);
					const body = new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(bytes);
						},
					});
					requests.push(
						fetch(`${daemon.origin}/api/hooks/session-end/uploads/${text(a.uploadId)}`, {
							method: "PATCH",
							headers: {
								authorization: `Bearer ${alice.connector.bearer}`,
								"content-type": "application/octet-stream",
								"upload-offset": "0",
								"upload-checksum": digest(bytes),
							},
							body,
							signal: controller.signal,
						}),
					);
				}
				const first = await Promise.race([
					...requests,
					new Promise<null>((resolve) => {
						timeout = setTimeout(() => resolve(null), 2500);
					}),
				]);
				assert(first, "One principal must not admit five slow PATCHes");
				assert.equal(first.status, 503);
				await first.arrayBuffer();
				const other = await append(daemon, bob, text(b.uploadId), 0, bytes);
				assert.equal(other.status, 200);
				await other.arrayBuffer();
			} finally {
				if (timeout) clearTimeout(timeout);
				for (const controller of controllers) controller.abort();
				await Promise.allSettled(requests);
			}
		}),
	180000,
);

test(
	"A21 upload creation uses session-end control admission before staging",
	() =>
		withUpload(async (daemon, fixture) => {
			const alice = fixture.user("alice"),
				bob = fixture.user("bob"),
				sessionKey = "bob-controlled-upload-session";
			success(
				await request(daemon.origin, "/api/hooks/session-start", bob.connector, "POST", {
					harness: "codex",
					sessionKey,
				}),
				"register Bob session",
			);
			const deniedEnd = await request(daemon.origin, "/api/hooks/session-end", alice.connector, "POST", {
				harness: "codex",
				sessionKey,
				reason: "session_shutdown",
			});
			assert.equal(deniedEnd.status, 403);
			const creation = await request(daemon.origin, "/api/hooks/session-end/uploads", alice.connector, "POST", {
				harness: "codex",
				sessionKey,
				totalBytes: 1,
				sha256: digest(Buffer.from("x")),
			});
			assert.equal(creation.status, 403, "a principal unable to end the session cannot stage its evidence");
			const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			try {
				assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM hook_transcript_uploads").get(), { count: 0 });
				assert.deepEqual(db.prepare("SELECT reserved_bytes FROM source_import_capacity WHERE id=1").get(), {
					reserved_bytes: 0,
				});
			} finally {
				db.close();
			}
		}),
	180000,
);
