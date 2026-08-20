import { existsSync } from "node:fs";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessorAsync } from "./db-accessor";
import { runTranscriptRecoveryScan, type TranscriptRecoveryScanOptions } from "./transcript-recovery-worker";

interface ChildInput {
	readonly basePath: string;
	readonly agentId: string;
	readonly options: Omit<TranscriptRecoveryScanOptions, "signal">;
}

async function main(): Promise<void> {
	const encoded = process.env.SIGNET_TRANSCRIPT_RECOVERY_INPUT;
	if (encoded === undefined) throw new Error("Transcript recovery child input is missing");
	const input = JSON.parse(encoded) as ChildInput;
	await initDbAccessorAsync(join(input.basePath, "memory", "memories.db"), { agentsDir: input.basePath });
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
