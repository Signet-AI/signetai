import { describe, expect, it } from "bun:test";
import {
	MigrationControlBoundary,
	WorkspaceAdmissionBarrier,
	WorkspaceMigrationRetryableError,
} from "./workspace-writer-barrier";

describe("workspace writer barrier", () => {
	it("controls drain, reports blockers, and rejects work after closing", async () => {
		const control = new MigrationControlBoundary("generation-a", 5);
		const release = control.admit("db-owner");
		expect(control.beginDrain()).toMatchObject({ generation: "generation-a", state: "draining" });
		expect(control.blockers()).toEqual([{ owner: "db-owner", active: 1, queued: 0 }]);
		release();
		await expect(control.close()).resolves.toMatchObject({ closed: true, blockers: [] });
		expect(control.state).toBe("closed");
		expect(() => control.admit("late-writer")).toThrow(WorkspaceMigrationRetryableError);
	});

	it("admits open work and rejects new work after draining begins", async () => {
		const barrier = new WorkspaceAdmissionBarrier("generation-a", 1);
		const release = barrier.admit("database-owner");
		barrier.beginDrain();
		expect(() => barrier.admit("scheduler")).toThrow(WorkspaceMigrationRetryableError);
		release();
		await expect(barrier.waitForDrain()).resolves.toMatchObject({ timedOut: false, blockers: [] });
		expect(barrier.state).toBe("closed");
	});

	it("returns named blockers when drain times out", async () => {
		const barrier = new WorkspaceAdmissionBarrier("generation-a", 5);
		barrier.admit("transcript-capture");
		barrier.beginDrain();
		await expect(barrier.waitForDrain()).resolves.toMatchObject({
			timedOut: true,
			blockers: [{ owner: "transcript-capture", active: 1 }],
		});
		barrier.close();
	});

	it("fences a writer before publication after the boundary closes", async () => {
		const control = new MigrationControlBoundary("generation-a", 1);
		const lease = control.acquireWriter("memory-publication");
		control.beginDrain();
		lease.release();
		await expect(control.close()).resolves.toMatchObject({ closed: true });
		expect(() => lease.assertCurrent()).toThrow(WorkspaceMigrationRetryableError);
	});
	it("fences writers resolved against an old generation", () => {
		const barrier = new WorkspaceAdmissionBarrier("generation-b", 1);
		expect(() => barrier.admit("old-writer", "generation-a")).toThrow(WorkspaceMigrationRetryableError);
		barrier.close();
	});
});
