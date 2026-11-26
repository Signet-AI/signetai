import { z } from "zod";
import { open, constants } from "node:fs/promises";
import { basename } from "node:path";
import { select, isCancel } from "@clack/prompts";
import { SignetError } from "../../../../libs/sdk/src/index.js";
import { cliTransport } from "../lib/organization-target.js";
import type { DaemonStreamResult } from "../lib/daemon.js";

export interface OrganizationImportOptions {
	agent?: string;
	json?: boolean;
	classification?: string;
	unclassified?: boolean;
	asEvidence?: boolean;
	nonInteractive?: boolean;
}
export async function importOrganizationEvidence(
	path: string,
	options: OrganizationImportOptions,
	stream: (path: string, options?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>,
) {
	if (!options.agent)
		throw new SignetError("Organization import requires --agent; no local database was opened", "agent_required");
	if (options.classification && options.unclassified)
		throw new SignetError("Choose --classification or --unclassified, not both", "invalid_request");
	const transport = cliTransport();
	if (!transport) throw new SignetError("Organization transport is unavailable", "target_required");
	const classifications = await transport.get<{ id: string; name: string }[]>("/api/classifications");
	let classificationId: string | undefined;
	if (options.classification) {
		const label = classifications.find(
			(item) => item.id === options.classification || item.name === options.classification,
		);
		if (!label) throw new SignetError("Classification is unavailable or not authorized", "classification_unavailable");
		classificationId = label.id;
	} else if (!options.unclassified) {
		if (options.json || options.nonInteractive || !process.stdin.isTTY)
			throw new SignetError(
				"Choose --classification <id> or --unclassified explicitly before importing evidence",
				"classification_required",
			);
		const choice = await select({
			message: "Which classification applies to this evidence?",
			options: [
				{ value: "", label: "Unclassified — readable under the agent's normal visibility" },
				...classifications.map((item) => ({ value: item.id, label: item.name })),
			],
		});
		if (isCancel(choice)) throw new SignetError("Import cancelled; nothing was uploaded", "cancelled");
		classificationId = choice || undefined;
	}
	if (/\.(?:json|jsonl|ndjson)$/i.test(path) && !options.asEvidence)
		throw new SignetError(
			"Portable derived-state restoration is not supported remotely. Use --as-evidence to preserve this file as source evidence instead; author and entity IDs are not trusted as authority",
			"evidence_confirmation_required",
		);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Buffer;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
			throw new SignetError("Import requires a regular file of at most 16 MiB", "import_limit");
		const buffer = Buffer.alloc(16 * 1024 * 1024 + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await file.read(buffer, offset, buffer.length - offset, null);
			if (!read.bytesRead) break;
			offset += read.bytesRead;
		}
		if (offset > 16 * 1024 * 1024) throw new SignetError("Import file grew beyond 16 MiB", "import_limit");
		bytes = buffer.subarray(0, offset);
	} finally {
		await file.close();
	}
	const form = new FormData();
	form.append(
		"files",
		new File([new Uint8Array(bytes)], options.asEvidence ? `${basename(path)}.txt` : basename(path), {
			type: options.asEvidence ? "text/plain" : "",
		}),
	);
	if (classificationId) form.set("classificationId", classificationId);
	const result = await stream("/api/sources/import", {
		method: "POST",
		body: form,
		headers: { "x-signet-agent-id": options.agent, "Idempotency-Key": `cli-import-${crypto.randomUUID()}` },
		timeout: 60_000,
	});
	if (!result.ok)
		throw new SignetError("Organization import transport failed; no local database was opened", "import_failed");
	const reader = result.response.body?.getReader();
	if (!reader) throw new SignetError("Missing import acknowledgement", "import_failed");
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > 65536) {
				await reader.cancel();
				throw new SignetError("Import acknowledgement exceeds its byte limit", "import_failed");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = z
		.object({
			imported: z.number().int().nonnegative(),
			failed: z.number().int().nonnegative(),
			files: z.array(z.object({ status: z.enum(["imported", "duplicate", "failed"]) }).passthrough()).length(1),
		})
		.passthrough()
		.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	if (body.failed)
		throw new SignetError(
			"The instance did not complete the document import; inspect its import diagnostics",
			"import_failed",
		);
	console.log(JSON.stringify(body, null, options.json ? undefined : 2));
}
