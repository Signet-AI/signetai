import { existsSync } from "node:fs";
import { resolveWorkspaceLayout } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessorAsync } from "./db-accessor";
import { runTranscriptRecoveryScan, type TranscriptRecoveryScanOptions } from "./transcript-recovery-worker";

interface ChildInput {
	readonly basePath: string;
	readonly agentId: string;
	readonly options: Omit<TranscriptRecoveryScanOptions, "signal">;
}

async function main(): Promise<void> {
	if (process.env.SIGNET_DB_WRITES_BLOCKED === "1") {
		throw new Error("Transcript recovery child refused writable accessor because database writes are blocked");
	}
	const encoded = process.env.SIGNET_TRANSCRIPT_RECOVERY_INPUT;
	if (encoded === undefined) throw new Error("Transcript recovery child input is missing");
	const input = JSON.parse(encoded) as ChildInput;
	await initDbAccessorAsync(resolveWorkspaceLayout(input.basePath).database, { agentsDir: input.basePath });
	try {
		const holdFile = process.env.SIGNET_TRANSCRIPT_RECOVERY_TEST_HOLD_FILE;
		while (holdFile !== undefined && existsSync(holdFile)) await new Promise((resolve) => setTimeout(resolve, 5));
		const result = await runTranscriptRecoveryScan(getDbAccessor(), input.basePath, input.agentId, input.options);
		process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
	} finally {
		closeDbAccessor();
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
