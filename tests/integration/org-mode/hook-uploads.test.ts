import "../../support/connector-safety.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, text, until } from "./http";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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
		const ended = success(
			await request(daemon.origin, "/api/hooks/session-end", user.connector, "POST", {
				harness: "codex",
				sessionKey,
				reason: "session_shutdown",
				transcriptUpload: { uploadId },
			}),
			"POST /api/hooks/session-end",
		);
		assert.equal(ended.queued, true);
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
	} finally {
		await daemon.dispose();
	}
}, 180_000);
