import "../../support/connector-safety.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, text } from "./http";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

test("source imports preserve staged bytes and replay offsets across daemon restart", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon);
		const user = fixture.user("alice");
		assert(user.session.bearer);
		const created = success(
			await request(daemon.origin, "/api/sources/imports", user.session, "POST", {
				files: [{ name: "staging-regression.jsonl" }],
			}),
			"POST /api/sources/imports",
		);
		const jobId = text(created.jobId);
		assert(Array.isArray(created.files));
		const fileId = text(record(created.files[0]).id);
		const path = `/api/sources/imports/${jobId}/files/${fileId}`;
		const first = Buffer.alloc(1024 * 1024, "source staging bytes\n");
		const last = Buffer.from("final staged bytes");
		const bytes = Buffer.concat([first, last]);
		async function append(offset: number, chunk: Buffer, sha256 = digest(chunk)): Promise<Response> {
			return fetch(`${daemon.origin}${path}`, {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${user.session.bearer}`,
					"content-type": "application/octet-stream",
					"upload-length": String(bytes.length),
					"upload-offset": String(offset),
					"upload-checksum": sha256,
				},
				body: new Uint8Array(chunk),
				signal: AbortSignal.timeout(30_000),
			});
		}
		const firstReply = await append(0, first);
		assert.equal(firstReply.status, 200);
		assert.equal(record(await firstReply.json()).offset, first.length);
		await daemon.restart();
		const replay = await append(0, first);
		assert.equal(replay.status, 200);
		assert.equal(record(await replay.json()).offset, first.length);
		const invalid = await append(first.length, last, digest(Buffer.from("incorrect")));
		assert.equal(invalid.status, 413, "A failed chunk checksum must not advance the durable offset");
		await invalid.arrayBuffer();
		const complete = await append(first.length, last);
		assert.equal(complete.status, 200);
		assert.equal(record(await complete.json()).offset, bytes.length);
		success(await request(daemon.origin, `${path}/finalize`, user.session, "POST", {}), "POST import finalize");
		const evidence = await fetch(
			`${daemon.origin}${path}/content?agent_id=${encodeURIComponent(text(created.agentId))}`,
			{
				headers: { authorization: `Bearer ${user.session.bearer}` },
				signal: AbortSignal.timeout(30_000),
			},
		);
		assert.equal(evidence.status, 200, await evidence.clone().text());
		assert(Buffer.from(await evidence.arrayBuffer()).equals(bytes), "Source staging must preserve every byte");
	} finally {
		await daemon.dispose();
	}
}, 180_000);

test("source import cancellation purges an incomplete multi-batch upload", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon);
		const user = fixture.user("alice");
		assert(user.session.bearer);
		const created = success(
			await request(daemon.origin, "/api/sources/imports", user.session, "POST", {
				files: [{ name: "cancelled-staging.jsonl" }],
			}),
			"POST /api/sources/imports",
		);
		assert(Array.isArray(created.files));
		const jobId = text(created.jobId);
		const fileId = text(record(created.files[0]).id);
		const chunks = [Buffer.alloc(1024 * 1024, 65), Buffer.alloc(64 * 1024, 66)];
		const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 1);
		let offset = 0;
		for (const chunk of chunks) {
			const response: Response = await fetch(`${daemon.origin}/api/sources/imports/${jobId}/files/${fileId}`, {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${user.session.bearer}`,
					"content-type": "application/octet-stream",
					"upload-length": String(totalBytes),
					"upload-offset": String(offset),
					"upload-checksum": digest(chunk),
				},
				body: new Uint8Array(chunk),
				signal: AbortSignal.timeout(30_000),
			});
			assert.equal(response.status, 200);
			offset += chunk.length;
			assert.equal(record(await response.json()).offset, offset);
		}
		success(
			await request(daemon.origin, `/api/sources/imports/${jobId}/cancel`, user.session, "POST", {}),
			"POST import cancel",
		);
		const state = success(
			await request(
				daemon.origin,
				`/api/sources/imports/${jobId}?agent_id=${encodeURIComponent(text(created.agentId))}`,
				user.session,
			),
			"GET cancelled import",
		);
		assert(Array.isArray(state.files));
		assert.equal(record(state.files[0]).storage_state, "purged");
		assert.equal(record(state.files[0]).reserved_bytes, 0);
	} finally {
		await daemon.dispose();
	}
}, 180_000);
