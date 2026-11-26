import { attemptAsync } from "@signet/core";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { open, link, unlink } from "node:fs/promises";
import { once } from "node:events";
import { z } from "zod";
import type { createDaemonClient } from "../lib/daemon.js";
import { cliTransport } from "../lib/organization-target.js";
import { SignetError } from "../../../../libs/sdk/src/index.js";

export async function exportOrganizationData(
	fetchStream: ReturnType<typeof createDaemonClient>["fetchDaemonStream"],
	options: { output?: string; author?: string; all?: boolean; maxBytes?: string },
) {
	const transport = cliTransport();
	if (!transport) throw new Error("Organization transport is unavailable");
	if (options.all && options.author) throw new SignetError("Choose --all or --author, not both", "invalid_scope");
	const identity = await transport.get<{ user: { id: string } }>("/api/auth/whoami");
	const query = new URLSearchParams(options.all ? { all: "1" } : { author: options.author ?? identity.user.id });
	const limit = z.coerce
		.number()
		.int()
		.min(1)
		.max(1024 * 1024 * 1024)
		.parse(options.maxBytes ?? 64 * 1024 * 1024);
	const controller = new AbortController(),
		timer = setTimeout(() => controller.abort(), 120_000);
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	const temporary = options.output ? `${options.output}.partial-${randomUUID()}` : null;
	let created = false;
	let file: Awaited<ReturnType<typeof open>> | undefined,
		reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
		bytes = 0,
		buffer = "";
	try {
		if (temporary) {
			file = await open(temporary, "wx", 0o600);
			created = true;
		}
		const response = await fetchStream(`/api/org/export?${query}`, { signal: controller.signal, timeout: 120_000 });
		if (!response.ok || !response.response.body)
			throw new SignetError("Organization export stream is unavailable", "export_unavailable");
		reader = response.response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const consume = async (line: string) => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new SignetError("Invalid export record", "invalid_export");
			}
			const row = z.object({ kind: z.string(), reason: z.unknown().optional() }).passthrough().parse(parsed);
			if (row.kind === "error")
				throw new SignetError(
					"The instance did not finish the export",
					typeof row.reason === "string" ? row.reason : "export_failed",
				);
			if (!["memories", "session_transcripts", "memory_artifacts"].includes(row.kind))
				throw new SignetError("Unknown export record kind", "invalid_export");
			const output = `${line}\n`;
			if (file) await file.writeFile(output);
			else if (!process.stdout.write(output)) await once(process.stdout, "drain", { signal: controller.signal });
		};
		while (true) {
			controller.signal.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > limit)
				throw new SignetError("Export exceeded --max-bytes; no completed file was published", "export_byte_limit");
			buffer += decoder.decode(part.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				await consume(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			if (Buffer.byteLength(buffer) > 64 * 1024 * 1024)
				throw new SignetError("Export record exceeds the 64 MiB record limit", "export_record_limit");
		}
		buffer += decoder.decode();
		if (buffer.trim()) throw new SignetError("Export ended with an incomplete record", "export_truncated");
		if (file && temporary && options.output) {
			await file.sync();
			await file.close();
			file = undefined;
			await link(temporary, options.output);
			if (process.platform !== "win32") {
				const directory = await open(dirname(options.output), "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		}
		if (options.output)
			console.log(JSON.stringify({ exported: true, path: options.output, bytes, format: "signet-org-ndjson" }));
	} finally {
		clearTimeout(timer);
		process.off("SIGINT", interrupt);
		if (reader) {
			await attemptAsync(() => reader.cancel());
			reader.releaseLock();
		}
		controller.abort();
		try {
			if (file) await file.close();
		} finally {
			if (temporary && created) await unlink(temporary);
		}
	}
}
