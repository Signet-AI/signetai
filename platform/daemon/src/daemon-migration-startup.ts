import type { DbOwnerClient } from "./db-owner-client";
import { readMigrationVerifySidecarStatus } from "./migration-integrity-verify";

function isMissingMigrationCheckpointTableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		/no such table:\s+(?:main\.)?db_integrity_checkpoints\b/i.test(message) ||
		/table\s+(?:main\.)?db_integrity_checkpoints\b.*not found/i.test(message)
	);
}

export async function readRetainedMigrationVerifyStatus(
	owner: DbOwnerClient,
	checkpointKey: string,
	backupPath: string,
): Promise<string | null> {
	const sidecarStatus = readMigrationVerifySidecarStatus(backupPath);
	if (sidecarStatus !== undefined) return sidecarStatus;
	try {
		const handle = owner.submit<{ readonly status?: unknown } | undefined>(
			{
				kind: "query",
				statement: {
					sql: "SELECT status FROM db_integrity_checkpoints WHERE checkpoint_key = ? LIMIT 1",
					params: [checkpointKey],
					result: "get",
					transactional: false,
					readonly: true,
				},
			},
			{ operation: "startup.read-retained-integrity-checkpoint", lane: "read", deadlineMs: 5_000 },
		);
		const row = await owner.awaitResult(handle, 5_000);
		return typeof row?.status === "string" ? row.status : null;
	} catch (error) {
		if (isMissingMigrationCheckpointTableError(error)) return null;
		throw error;
	}
}

export interface ProductionMigrationVerificationWiring {
	readonly owner: Pick<DbOwnerClient, "setWriteBlocked">;
	readonly backupPath: string;
	readonly verify: () => Promise<{ readonly phase: "pass" | "parked" | "failed" | "terminal" }>;
	readonly pruneBackup: (backupPath: string) => void | Promise<void>;
	readonly schedule: (callback: () => void, delayMs: number) => void;
	readonly requestShutdown: (reason: string) => void;
}
export async function runProductionMigrationVerificationWiring(
	wiring: ProductionMigrationVerificationWiring,
): Promise<{ readonly phase: "pass" | "parked" | "failed" | "terminal" }> {
	wiring.owner.setWriteBlocked(true);
	const result = await wiring.verify();
	if (result.phase === "pass") {
		await wiring.pruneBackup(wiring.backupPath);
		wiring.schedule(() => wiring.requestShutdown("migration-verify-complete-restart"), 0);
	}
	return result;
}
