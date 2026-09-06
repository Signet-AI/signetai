import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
import type { DbAccessor } from "./db-accessor";
import { resetGlobalIntegrityLatch, updateDatabaseIntegrityStatus } from "./database-integrity";
import { runOperatorIntegrityCheck } from "./database-integrity-check";

const resources: Array<{
	readonly directory: string;
	readonly owner: ReturnType<typeof createDbOwnerClient>;
}> = [];

afterEach(async () => {
	for (const resource of resources.splice(0)) {
		await resource.owner.close();
		rmSync(resource.directory, { recursive: true, force: true });
	}
	resetGlobalIntegrityLatch();
	updateDatabaseIntegrityStatus({
		checkpointKey: "test.integrity.cleanup",
		phase: "complete",
		checkedObjects: 0,
		failedObjects: 0,
		remainingObjects: 0,
		lastObject: null,
		databasePagesObserved: 0,
		databaseBytesObserved: 0,
		elapsedMs: 0,
		ownerQueueAdmissionMs: 0,
		ownerExecutionMs: 0,
		cancellationReason: null,
		degradationReason: null,
	});
});

function makeDatabase(): {
	readonly directory: string;
	readonly path: string;
	readonly owner: ReturnType<typeof createDbOwnerClient>;
} {
	const directory = mkdtempSync(join(tmpdir(), "operator-integrity-"));
	const path = join(directory, "memory.db");
	const database = new Database(path);
	database.exec(
		"CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL); INSERT INTO memories VALUES ('m1', 'owner boundary');",
	);
	database.close();
	const owner = createDbOwnerClient({ dbPath: path });
	resources.push({ directory, owner });
	return { directory, path, owner };
}

function parentlessAccessor(): DbAccessor {
	const fail = (): never => {
		throw new Error("integrity verification used the HTTP parent database callback");
	};
	return {
		withReadDb: fail,
		withReadDbAsync: fail,
		withWriteTx: fail,
		withWriteTxAsync: fail,
		withWriteDbAsync: fail,
		close: () => undefined,
	} as unknown as DbAccessor;
}

describe("operator integrity owner boundary", () => {
	it("runs both global checks in the database owner, not the HTTP accessor", async () => {
		const database = makeDatabase();
		const progress: Array<{
			readonly phase: string;
			readonly checkpointKey: string;
			readonly remainingObjects: number;
		}> = [];
		const result = await runOperatorIntegrityCheck(parentlessAccessor(), {
			owner: database.owner,
			deadlineMs: 5_000,
			onProgress: (snapshot) => {
				progress.push({
					phase: snapshot.phase,
					checkpointKey: snapshot.checkpointKey,
					remainingObjects: snapshot.remainingObjects,
				});
			},
		});

		expect(result).toMatchObject({
			ok: true,
			phase: "complete",
			outcome: "passed",
			executionHome: "db-owner.verify",
			checkpointKey: "database.operator-integrity",
		});
		expect(result.quickCheck).toEqual({ ok: true, messages: [] });
		expect(result.fullCheck).toEqual({ ok: true, messages: [] });
		expect(progress[0]).toMatchObject({
			phase: "running",
			checkpointKey: "database.operator-integrity",
			remainingObjects: 2,
		});
		expect(progress.at(-1)).toMatchObject({
			phase: "complete",
			checkpointKey: "database.operator-integrity",
			remainingObjects: 0,
		});
		expect(database.owner.health().lanes?.maintenance?.pid).not.toBe(process.pid);
	});

	it("reports cancellation explicitly before starting a global scan", async () => {
		const database = makeDatabase();
		const controller = new AbortController();
		controller.abort();

		const result = await runOperatorIntegrityCheck(parentlessAccessor(), {
			owner: database.owner,
			signal: controller.signal,
			deadlineMs: 5_000,
		});

		expect(result).toMatchObject({ ok: false, phase: "cancelled", outcome: "cancelled" });
		expect(result.error).toContain("cancelled");
	});
});
