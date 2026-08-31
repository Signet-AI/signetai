import { createHash } from "node:crypto";

export const TRANSCRIPT_IMPORT_LIMITS = {
	maxRecordsPerBatch: 25,
	maxCanonicalBatchBytes: 8 * 1024 * 1024,
	maxRecordBytes: 16 * 1024 * 1024,
	maxMessageBytes: 4 * 1024 * 1024,
	maxMessages: 50_000,
} as const;

export const TRANSCRIPT_ROLES = ["user", "assistant", "system", "tool", "unknown"] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];
export interface CompletedTranscriptMessage {
	readonly role: TranscriptRole;
	readonly content: string;
}
export interface SignetExportRecord {
	readonly id: string;
	readonly source: "signet";
	readonly harness: string;
	readonly agent_id: string;
	readonly session_key: string;
	readonly project: string | null;
	readonly timestamp: string;
	readonly message_count: number;
	readonly messages: readonly CompletedTranscriptMessage[];
}
export interface TranscriptAdapter {
	readonly id: "signet-export";
	readonly version: 1;
	parse(value: unknown): SignetExportRecord;
}

function isRole(value: unknown): value is TranscriptRole {
	return typeof value === "string" && (TRANSCRIPT_ROLES as readonly string[]).includes(value);
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
export function validateSignetExport(value: unknown): SignetExportRecord {
	if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
	const r = value as Record<string, unknown>;
	for (const field of ["id", "harness", "agent_id", "session_key"] as const)
		if (!nonempty(r[field])) throw new Error(`${field} must be nonempty`);
	if (r.source !== "signet") throw new Error("source must be signet");
	if (typeof r.project !== "string" && r.project !== null) throw new Error("project must be string or null");
	if (typeof r.timestamp !== "string" || Number.isNaN(Date.parse(r.timestamp))) throw new Error("timestamp is invalid");
	if (!Array.isArray(r.messages) || r.messages.length > TRANSCRIPT_IMPORT_LIMITS.maxMessages)
		throw new Error("messages is invalid or oversized");
	const messages: CompletedTranscriptMessage[] = [];
	for (const message of r.messages) {
		if (message == null || typeof message !== "object" || Array.isArray(message)) throw new Error("message is invalid");
		const m = message as Record<string, unknown>;
		if (!isRole(m.role) || typeof m.content !== "string") throw new Error("message role/content is invalid");
		if (Buffer.byteLength(m.content, "utf8") > TRANSCRIPT_IMPORT_LIMITS.maxMessageBytes)
			throw new Error("message is oversized");
		messages.push({ role: m.role, content: m.content });
	}
	if (r.message_count !== messages.length || typeof r.message_count !== "number")
		throw new Error("message_count mismatch");
	if (!messages.some((m) => m.content.length > 0)) throw new Error("record has no nonempty message");
	return {
		id: r.id as string,
		source: "signet",
		harness: r.harness as string,
		agent_id: r.agent_id as string,
		session_key: r.session_key as string,
		project: r.project as string | null,
		timestamp: r.timestamp as string,
		message_count: r.message_count,
		messages,
	};
}
export const signetExportV1Adapter: TranscriptAdapter = {
	id: "signet-export",
	version: 1,
	parse: validateSignetExport,
};

function fixed(fields: readonly string[]): string {
	return fields.map((field) => `${field.length}:${field}`).join("|");
}
export function externalIdentityFingerprint(
	record: Pick<SignetExportRecord, "agent_id" | "harness" | "session_key">,
): string {
	return createHash("sha256")
		.update(fixed([record.agent_id, record.harness, record.session_key]))
		.digest("hex");
}
export function conversationFingerprint(record: SignetExportRecord): string {
	return createHash("sha256")
		.update(
			fixed([
				record.agent_id,
				record.harness,
				record.session_key,
				record.project ?? "",
				record.timestamp,
				...record.messages.flatMap((m) => [m.role, m.content]),
			]),
		)
		.digest("hex");
}
export function canonicalTranscriptIdentity(record: SignetExportRecord): {
	readonly canonicalId: string;
	readonly canonicalKey: string;
	readonly contentHash: string;
} {
	const contentHash = conversationFingerprint(record);
	const digest = createHash("sha256")
		.update(fixed([externalIdentityFingerprint(record), contentHash]))
		.digest("hex");
	return { canonicalId: `import:${digest}`, canonicalKey: `import:${digest}`, contentHash };
}
