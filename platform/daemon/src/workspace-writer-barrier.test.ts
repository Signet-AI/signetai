import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	MigrationLease,
	MigrationWriterRegistry,
	WorkspaceAdmissionBarrier,
	WorkspaceMigrationRetryableError,
} from "./workspace-writer-barrier";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
	const dir = mkdtempSync(join("/tmp", "signet-writer-barrier-"));
	dirs.push(dir);
	return dir;
}

describe("workspace writer barrier", () => {
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

	it("registers writers and drains them through one owner registry", async () => {
		const registry = new MigrationWriterRegistry();
		const barrier = new WorkspaceAdmissionBarrier("generation-a", 50);
		const unregister = registry.register("dreaming", barrier);
		const release = barrier.admit("dreaming");
		barrier.beginDrain();
		release();
		await expect(registry.drainAll()).resolves.toEqual([]);
		unregister();
		expect(registry.owners()).toEqual([]);
	});

	it("uses an exclusive OS lease and releases ownership on shutdown", async () => {
		const path = join(tempDir(), "migration.lock");
		const first = await MigrationLease.acquire(path, { workspace: "/workspace/a", generation: "generation-a" });
		await expect(
			MigrationLease.acquire(path, { workspace: "/workspace/a", generation: "generation-a" }),
		).rejects.toThrow();
		await first.release();
		const second = await MigrationLease.acquire(path, { workspace: "/workspace/a", generation: "generation-a" });
		await second.release();
	});

	it("fences writers resolved against an old generation", () => {
		const barrier = new WorkspaceAdmissionBarrier("generation-b", 1);
		expect(() => barrier.admit("old-writer", "generation-a")).toThrow(WorkspaceMigrationRetryableError);
		barrier.close();
	});
});
