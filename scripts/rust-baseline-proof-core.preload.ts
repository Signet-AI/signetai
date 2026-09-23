import { mock } from "bun:test";
import { resolve } from "node:path";
import { appendFileSync } from "node:fs";
import { formatFreshRustCoreEvidence } from "./rust-baseline-proof-evidence";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native proof artifact
const driver = process.env.SIGNET_RUST_CORE_DRIVER_BIN;
if (!driver) throw new Error("SIGNET_RUST_CORE_DRIVER_BIN is required");
const driverPath: string = driver;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native proof artifact
const evidenceFile = process.env.SIGNET_RUST_CORE_EVIDENCE_FILE;

function recordEvidence(operation: string): void {
	if (!evidenceFile) throw new Error("SIGNET_RUST_CORE_EVIDENCE_FILE is required");
	appendFileSync(evidenceFile, formatFreshRustCoreEvidence(driverPath, operation));
}

// biome-ignore lint/suspicious/noExplicitAny: transport JSON is intentionally dynamic.
function call(path: string, request: Record<string, unknown>): any {
	const result = Bun.spawnSync([driverPath, path], {
		stdin: Buffer.from(`${JSON.stringify(request)}\n{"op":"close"}\n`),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (process.env.SIGNET_RUST_CORE_EVIDENCE_PROBE === "1") recordEvidence(String(request.op ?? "unknown"));
	if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	const line = new TextDecoder().decode(result.stdout).trim().split("\n")[0] ?? "";
	const response = JSON.parse(line);
	if (!response.ok) throw new Error(JSON.stringify(response));
	recordEvidence(String(request.op ?? "unknown"));
	return response.result;
}

export class Database {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
	async init() {
		call(this.path, { op: "init" });
	}
	// biome-ignore lint/suspicious/noExplicitAny: preserve baseline input shape.
	addMemory(input: any) {
		const metadata = { ...input };
		delete metadata.type;
		delete metadata.content;
		delete metadata.confidence;
		delete metadata.tags;
		delete metadata.updatedBy;
		delete metadata.vectorClock;
		delete metadata.manualOverride;
		return call(this.path, { op: "remember", agentId: "default", content: input.content, metadata }).id;
	}
	getMemoryById(id: string) {
		const value = call(this.path, { op: "get", agentId: "default", id });
		return {
			id: value.id,
			sourceId: value.sourceId,
			sourceType: value.sourceType,
			sourcePath: value.sourcePath,
			runtimePath: value.runtimePath,
			idempotencyKey: value.idempotencyKey,
		};
	}
	close() {}
}

const databaseModulePaths = [
	resolve(import.meta.dir, "../platform/core/src/database.ts"),
	resolve(import.meta.dir, "../platform/core/src/database"),
	"/mnt/work/hermes-scratch/pr-1867-main/platform/core/src/database.ts",
	"/mnt/work/hermes-scratch/pr-1867-main/platform/core/src/database",
];
const realDatabaseModulePath = `${databaseModulePaths[0] as string}?rust-adapter-real`;
for (const modulePath of databaseModulePaths)
	mock.module(modulePath, async () => ({ ...(await import(realDatabaseModulePath)), Database }));
