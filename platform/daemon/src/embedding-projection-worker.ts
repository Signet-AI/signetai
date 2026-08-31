import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import { computeProjectionFromRows, type EmbeddingProjectionRow, type ProjectionResult } from "./umap-projection";
import {
	PROJECTION_CONTENT_MAX_CHARS,
	PROJECTION_MAX_ROWS,
	PROJECTION_SNAPSHOT_MAX_BYTES,
	PROJECTION_VECTOR_DIMENSIONS,
	type ProjectionSnapshotDescriptor,
	type ProjectionSnapshotWire,
} from "./embedding-projection-contract";

export interface ProjectionWorkerRow extends Omit<EmbeddingProjectionRow, "vector"> {
	readonly vectorHex: string;
}

export interface ProjectionWorkerInput {
	readonly dimensions: 2 | 3;
	readonly rows: readonly ProjectionWorkerRow[];
}

export class ProjectionWorkerInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectionWorkerInputError";
	}
}

function hexToBytes(value: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/i.test(value))
		throw new ProjectionWorkerInputError("projection worker received an invalid vector");
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function parseInput(value: unknown): ProjectionWorkerInput {
	if (typeof value !== "object" || value === null)
		throw new ProjectionWorkerInputError("projection worker input is not an object");
	const input = value as Record<string, unknown>;
	if (input.version === 1 && typeof input.path === "string" && typeof input.outputDirectory === "string") {
		const descriptor = input as unknown as ProjectionSnapshotDescriptor;
		if (!isAbsolute(descriptor.path) || relative(descriptor.outputDirectory, descriptor.path).startsWith(".."))
			throw new ProjectionWorkerInputError("projection snapshot path is outside its artifact directory");
		let bytes: Buffer;
		try {
			const stat = statSync(descriptor.path);
			if (stat.size > PROJECTION_SNAPSHOT_MAX_BYTES) throw new Error("snapshot exceeds byte bound");
			bytes = readFileSync(descriptor.path);
		} catch (error) {
			throw new ProjectionWorkerInputError(
				`projection snapshot could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let wire: ProjectionSnapshotWire;
		try {
			wire = JSON.parse(bytes.toString("utf8")) as ProjectionSnapshotWire;
		} catch {
			throw new ProjectionWorkerInputError("projection snapshot is not valid JSON");
		}
		if (
			wire.version !== 1 ||
			!Array.isArray(wire.rows) ||
			typeof wire.request !== "object" ||
			wire.request === null ||
			(wire.request.dimensions !== 2 && wire.request.dimensions !== 3)
		)
			throw new ProjectionWorkerInputError("projection snapshot is invalid");
		return parseInput({ dimensions: wire.request.dimensions, rows: wire.rows });
	}
	if (input.dimensions !== 2 && input.dimensions !== 3)
		throw new ProjectionWorkerInputError("projection worker dimensions must be 2 or 3");
	if (!Array.isArray(input.rows)) throw new ProjectionWorkerInputError("projection worker rows are missing");
	if (input.rows.length > PROJECTION_MAX_ROWS)
		throw new ProjectionWorkerInputError(`projection worker rows exceed ${PROJECTION_MAX_ROWS}`);
	const rows = input.rows.map((raw, index) => {
		if (typeof raw !== "object" || raw === null)
			throw new ProjectionWorkerInputError(`projection worker row ${index} is invalid`);
		const row = raw as Record<string, unknown>;
		if (typeof row.vectorHex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(row.vectorHex))
			throw new ProjectionWorkerInputError(`projection worker row ${index} has no valid vector`);
		if (row.vectorHex.length > PROJECTION_VECTOR_DIMENSIONS * 8)
			throw new ProjectionWorkerInputError(`projection worker row ${index} exceeds vector bound`);
		const content = typeof row.content === "string" ? row.content : "";
		if (content.length > PROJECTION_CONTENT_MAX_CHARS)
			throw new ProjectionWorkerInputError(`projection worker row ${index} exceeds content bound`);
		const id = typeof row.id === "string" ? row.id : "";
		if (!id || typeof row.created_at !== "string")
			throw new ProjectionWorkerInputError(`projection worker row ${index} metadata is invalid`);
		return {
			id,
			content,
			who: typeof row.who === "string" ? row.who : null,
			importance: typeof row.importance === "number" && Number.isFinite(row.importance) ? row.importance : null,
			type: typeof row.type === "string" ? row.type : null,
			tags: typeof row.tags === "string" ? row.tags : null,
			pinned: typeof row.pinned === "number" ? row.pinned : null,
			source_type: typeof row.source_type === "string" ? row.source_type : null,
			source_id: typeof row.source_id === "string" ? row.source_id : null,
			created_at: row.created_at,
			vectorHex: row.vectorHex,
			dimensions: typeof row.dimensions === "number" ? row.dimensions : null,
		};
	});
	return { dimensions: input.dimensions, rows };
}

export function computeProjectionWorkerInput(input: ProjectionWorkerInput): ProjectionResult {
	return computeProjectionFromRows(
		input.rows.map(({ vectorHex, ...row }) => ({ ...row, vector: hexToBytes(vectorHex) })),
		input.dimensions,
	);
}

async function readStdin(): Promise<string> {
	const chunks: string[] = [];
	const reader = createInterface({ input: process.stdin });
	for await (const line of reader) chunks.push(line);
	return chunks.join("\n");
}

export async function runEmbeddingProjectionWorker(): Promise<void> {
	const encoded = await readStdin();
	const input = parseInput(JSON.parse(encoded));
	if (process.env.SIGNET_PROJECTION_WORKER_HOLD === "1") {
		await new Promise<void>(() => setInterval(() => undefined, 1_000));
	}
	const result = computeProjectionWorkerInput(input);
	// Keep the already-serialized payload available to the parent so it can
	// publish it through the DB owner without serializing a large projection in
	// the daemon event loop a second time.
	process.stdout.write(`${JSON.stringify({ type: "result" })}\n${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1] ?? "";
if (
	process.env.SIGNET_EMBEDDING_PROJECTION_WORKER === "1" &&
	(entrypoint.endsWith("embedding-projection-worker.ts") ||
		entrypoint.endsWith("embedding-projection-worker.js") ||
		entrypoint.endsWith("embedding-projection-worker.mjs"))
) {
	void runEmbeddingProjectionWorker().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
}
