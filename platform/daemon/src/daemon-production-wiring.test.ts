/** Behavioral coverage for the production migration startup seams. */
import { describe, expect, it } from "bun:test";
import {
	readRetainedMigrationVerifyStatus,
	runProductionMigrationVerificationWiring,
} from "./daemon-migration-startup";

function ownerThatFails(error: Error): Parameters<typeof readRetainedMigrationVerifyStatus>[0] {
	return {
		setWriteBlocked: () => {},
		submit: () => ({
			job: {} as never,
			result: Promise.reject(error),
			cancel: () => {},
		}),
		awaitResult: (handle: { readonly result: Promise<unknown> }) => handle.result,
	} as never;
}

describe("daemon production migration wiring", () => {
	it("treats only the named missing checkpoint table as absent", async () => {
		const missingTable = await readRetainedMigrationVerifyStatus(
			ownerThatFails(new Error("SQLiteError: no such table: db_integrity_checkpoints")),
			"database.migration-verify:backup",
			"/tmp/daemon-production-wiring-missing-backup",
		);
		expect(missingTable).toBeNull();
	});

	it("fails closed when checkpoint reads hit I/O or owner timeout errors", async () => {
		await expect(
			readRetainedMigrationVerifyStatus(
				ownerThatFails(new Error("SQLiteError: disk I/O error")),
				"database.migration-verify:backup",
				"/tmp/daemon-production-wiring-io-backup",
			),
		).rejects.toThrow("disk I/O error");
		await expect(
			readRetainedMigrationVerifyStatus(
				ownerThatFails(new Error("DB_OWNER_DEADLINE: owner job timed out")),
				"database.migration-verify:backup",
				"/tmp/daemon-production-wiring-timeout-backup",
			),
		).rejects.toThrow("owner job timed out");
	});

	it("observes retained-unverified to pass, prune, and restart wiring", async () => {
		const events: string[] = [];
		let scheduled: (() => void) | undefined;
		const backupPath = "/tmp/retained-legacy.bak-v151-1234";
		const result = await runProductionMigrationVerificationWiring({
			owner: {
				setWriteBlocked: (blocked) => events.push(`write-block:${blocked}`),
			},
			backupPath,
			verify: async () => {
				events.push("verify");
				return { phase: "pass" };
			},
			pruneBackup: (path) => {
				events.push(`prune:${path}`);
			},
			schedule: (callback, delayMs) => {
				events.push(`schedule:${delayMs}`);
				scheduled = callback;
			},
			requestShutdown: (reason) => events.push(`shutdown:${reason}`),
		});

		expect(result.phase).toBe("pass");
		expect(events).toEqual(["write-block:true", "verify", `prune:${backupPath}`, "schedule:0"]);
		expect(scheduled).toBeDefined();
		scheduled?.();
		expect(events.at(-1)).toBe("shutdown:migration-verify-complete-restart");
	});

	it("does not prune or restart a parked verification", async () => {
		const events: string[] = [];
		await runProductionMigrationVerificationWiring({
			owner: { setWriteBlocked: (blocked) => events.push(`write-block:${blocked}`) },
			backupPath: "/tmp/retained-parked.bak-v151-1234",
			verify: async () => ({ phase: "parked" }),
			pruneBackup: () => {
				events.push("prune");
			},
			schedule: () => {
				events.push("schedule");
			},
			requestShutdown: () => {
				events.push("shutdown");
			},
		});
		expect(events).toEqual(["write-block:true"]);
	});
});
