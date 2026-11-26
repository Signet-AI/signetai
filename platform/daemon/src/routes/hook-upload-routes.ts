import { logger } from "../logger";
import { DbOwnerError } from "../db-owner-client";
import { resolveDaemonAgentId } from "../agent-id";
import type { Context, Hono } from "hono";
import { jsonBody } from "../request-body";
import { requirePermission } from "../auth";
import { attemptAsync } from "@signet/core";
import { authConfig } from "./state";
import { resolveScopedAgentId, validateSessionControl } from "./utils";
import {
	createHookUpload,
	createHookUploadAdmission,
	HOOK_TRANSCRIPT_BYTES,
	getHookUpload,
	hookUploadScope,
	hookUploadStaging,
	HookUploadMissing,
	HookUploadBusy,
	HookUploadChecksumMismatch,
	abortHookUpload,
} from "../hook-transcript-uploads";
import { UploadOffsetConflict, UploadIncomplete, TRANSCRIPT_UPLOAD_BYTES } from "../staged-upload-owner";

export function isHookUploadCallerError(error: unknown): boolean {
	return (
		error instanceof HookUploadMissing ||
		error instanceof HookUploadBusy ||
		error instanceof HookUploadChecksumMismatch ||
		error instanceof UploadOffsetConflict ||
		error instanceof UploadIncomplete
	);
}
export function hookUploadErrorResponse(c: Context, error: unknown): Response {
	if (error instanceof DbOwnerError && error.code === "classified_destination")
		return c.json({ error: "classified destination", reason: "classified_destination" }, 403);
	if (error instanceof UploadOffsetConflict)
		return c.json(
			{ error: "Upload offset conflict", reason: "upload_offset_conflict", receivedBytes: error.receivedBytes },
			409,
		);
	if (error instanceof UploadIncomplete)
		return c.json({ error: "Upload incomplete", reason: "upload_incomplete", receivedBytes: error.receivedBytes }, 409);
	if (error instanceof HookUploadChecksumMismatch)
		return c.json({ error: "Upload checksum mismatch", reason: "upload_checksum_mismatch" }, 422);
	if (error instanceof HookUploadMissing) return c.json({ error: "Upload not found" }, 404);
	if (error instanceof HookUploadBusy) return c.json({ error: "Upload capacity unavailable", reason: "busy" }, 503);
	if (error instanceof RangeError) return c.json({ error: "Invalid upload bounds or checksum" }, 400);
	logger.warn("hooks", "Hook upload unavailable", {
		error: error instanceof Error ? error.message : "Unknown upload failure",
	});
	return c.json({ error: "Upload unavailable", reason: "upload_unavailable" }, 503);
}
async function chunkBytes(request: Request): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) throw new RangeError("Chunk body required");
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
	const cancel = () => {
		void attemptAsync(() => reader.cancel(signal.reason));
	};
	signal.addEventListener("abort", cancel, { once: true });
	const buffer = new Uint8Array(TRANSCRIPT_UPLOAD_BYTES);
	let length = 0,
		turns = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const item = await reader.read();
			signal.throwIfAborted();
			if (item.done) return buffer.subarray(0, length);
			if (length + item.value.length > buffer.length) throw new RangeError("Chunk too large");
			buffer.set(item.value, length);
			length += item.value.length;
			if (++turns % 1024 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await attemptAsync(() => reader.cancel());
		reader.releaseLock();
	}
}
export function registerHookUploadRoutes(app: Hono): void {
	const acquireTransfer = createHookUploadAdmission();
	app.use("/api/hooks/session-end/uploads", requirePermission("remember", authConfig));
	app.use("/api/hooks/session-end/uploads/*", requirePermission("remember", authConfig));
	app.post("/api/hooks/session-end/uploads", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Authentication required" }, 401);
		const raw = await jsonBody(c)<unknown>();
		if (
			typeof raw !== "object" ||
			raw === null ||
			!("sessionKey" in raw) ||
			typeof raw.sessionKey !== "string" ||
			!("harness" in raw) ||
			typeof raw.harness !== "string" ||
			!("totalBytes" in raw) ||
			typeof raw.totalBytes !== "number" ||
			!("sha256" in raw) ||
			typeof raw.sha256 !== "string"
		)
			return c.json({ error: "Invalid upload declaration" }, 400);
		if (
			!raw.sessionKey.trim() ||
			raw.sessionKey.length > 1024 ||
			!/^[a-z0-9-]{1,64}$/.test(raw.harness) ||
			!/^[a-f0-9]{64}$/.test(raw.sha256)
		)
			return c.json({ error: "Invalid upload declaration" }, 400);
		if (principal.harness !== null && principal.harness !== raw.harness)
			return c.json({ error: "Harness binding conflict", reason: "harness_binding_conflict" }, 403);
		if (raw.totalBytes > HOOK_TRANSCRIPT_BYTES)
			return c.json({ error: "Transcript exceeds upload byte limit", reason: "upload_too_large" }, 413);
		const agent = resolveScopedAgentId(c, c.get("requestedOrganizationAgent"), resolveDaemonAgentId());
		if (agent.error) return c.json({ error: agent.error }, 403);
		const uploadAdmissionError = await validateSessionControl(c, raw.sessionKey, agent.agentId, {
			context: "sessionKey",
		});
		if (uploadAdmissionError) return c.json({ error: uploadAdmissionError }, 403);
		try {
			const row = await createHookUpload(principal, agent.agentId, {
				sessionKey: raw.sessionKey,
				harness: raw.harness,
				totalBytes: raw.totalBytes,
				sha256: raw.sha256,
			});
			return c.json({ uploadId: row.id, chunkBytes: TRANSCRIPT_UPLOAD_BYTES, receivedBytes: row.upload_offset }, 201);
		} catch (error) {
			return hookUploadErrorResponse(c, error);
		}
	});
	app.delete("/api/hooks/session-end/uploads/:id", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Authentication required" }, 401);
		try {
			await abortHookUpload(principal, c.req.param("id"));
			return c.json({ aborted: true });
		} catch (error) {
			return hookUploadErrorResponse(c, error);
		}
	});
	app.get("/api/hooks/session-end/uploads/:id", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Authentication required" }, 401);
		try {
			const row = await getHookUpload(principal, c.req.param("id"));
			return c.json({ uploadId: row.id, receivedBytes: row.upload_offset, chunkBytes: TRANSCRIPT_UPLOAD_BYTES });
		} catch (error) {
			return hookUploadErrorResponse(c, error);
		}
	});
	app.patch("/api/hooks/session-end/uploads/:id", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Authentication required" }, 401);
		const release = acquireTransfer(principal);
		if (!release) return c.json({ error: "Upload capacity unavailable", reason: "busy" }, 503);
		try {
			const row = await getHookUpload(principal, c.req.param("id"));
			const offset = c.req.header("upload-offset"),
				checksum = c.req.header("upload-checksum");
			if (offset === undefined || !/^\d+$/.test(offset) || !checksum)
				return c.json({ error: "upload-offset and upload-checksum required" }, 400);
			const bytes = await chunkBytes(c.req.raw);
			const receivedBytes = await hookUploadStaging.append(
				{ ...hookUploadScope(row), generation: row.upload_generation, signal: c.req.raw.signal },
				Number(offset),
				bytes,
				checksum,
			);
			return c.json({ uploadId: row.id, receivedBytes });
		} catch (error) {
			return hookUploadErrorResponse(c, error);
		} finally {
			release();
		}
	});
}
