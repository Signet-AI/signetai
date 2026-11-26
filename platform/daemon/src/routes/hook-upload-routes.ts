import { resolveDaemonAgentId } from "../agent-id";
import type { Context, Hono } from "hono";
import { jsonBody } from "../request-body";
import { requirePermission } from "../auth";
import { attemptAsync } from "@signet/core";
import { authConfig } from "./state";
import { resolveScopedAgentId } from "./utils";
import {
	createHookUpload,
	getHookUpload,
	hookUploadScope,
	hookUploadStaging,
	HookUploadMissing,
	HookUploadBusy,
} from "../hook-transcript-uploads";
import { TRANSCRIPT_UPLOAD_BYTES } from "../staged-upload-owner";

function response(c: Context, error: unknown): Response {
	if (error instanceof HookUploadMissing) return c.json({ error: "Upload not found" }, 404);
	if (error instanceof HookUploadBusy) return c.json({ error: "Upload capacity unavailable", reason: "busy" }, 503);
	if (error instanceof RangeError) return c.json({ error: "Invalid upload bounds or checksum" }, 400);
	throw error;
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
	let transfers = 0;
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
		const agent = resolveScopedAgentId(c, c.get("requestedOrganizationAgent"), resolveDaemonAgentId());
		if (agent.error) return c.json({ error: agent.error }, 403);
		try {
			const row = await createHookUpload(principal, agent.agentId, {
				sessionKey: raw.sessionKey,
				harness: raw.harness,
				totalBytes: raw.totalBytes,
				sha256: raw.sha256,
			});
			return c.json({ uploadId: row.id, chunkBytes: TRANSCRIPT_UPLOAD_BYTES, receivedBytes: row.upload_offset }, 201);
		} catch (error) {
			return response(c, error);
		}
	});
	app.get("/api/hooks/session-end/uploads/:id", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Authentication required" }, 401);
		try {
			const row = await getHookUpload(principal, c.req.param("id"));
			return c.json({ uploadId: row.id, receivedBytes: row.upload_offset, chunkBytes: TRANSCRIPT_UPLOAD_BYTES });
		} catch (error) {
			return response(c, error);
		}
	});
	app.patch("/api/hooks/session-end/uploads/:id", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Authentication required" }, 401);
		if (transfers >= 16) return c.json({ error: "Upload capacity unavailable", reason: "busy" }, 503);
		transfers++;
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
			return response(c, error);
		} finally {
			transfers--;
		}
	});
}
