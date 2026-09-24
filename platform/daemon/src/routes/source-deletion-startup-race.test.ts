import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addObsidianSource, loadSourcesConfig } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import {
	clearSourceIndexInFlight,
	clearSourceIndexProgressForTests,
	beginSourceIndexJob,
	markSourceIndexInFlight,
	markSourceIndexJobRunning,
	trackSourceIndexRun,
	waitForSourceIndexRuns,
} from "../source-index-progress";
import {
	obsidianNativeMemorySource,
	purgeNativeMemorySourceArtifacts,
	startNativeMemoryBridge,
} from "../native-memory-sources";
import { beginSourceMutation } from "../source-deletion-lock";
import { finalizeCancelledSourceIndexJob, registerSourcesRoutes } from "./sources-routes";
import type { NativeMemoryBridgeHandle } from "../native-memory-sources";

describe("startup source-index deletion race", () => {
	let agentsDir = "";
	let vault = "";
	let previousSignetPath: string | undefined;
	let previousSignetAgentId: string | undefined;
	let bridge: NativeMemoryBridgeHandle | null = null;

	beforeEach(async () => {
		clearSourceIndexProgressForTests();
		agentsDir = mkdtempSync(join(tmpdir(), "signet-startup-source-delete-"));
		vault = join(agentsDir, "vault");
		mkdirSync(join(vault, "permanent"), { recursive: true });
		writeFileSync(join(vault, "permanent", "First.md"), "# First\n\nFirst startup source artifact.");
		writeFileSync(join(vault, "permanent", "Second.md"), "# Second\n\nSecond startup source artifact.");
		previousSignetPath = process.env.SIGNET_PATH;
		previousSignetAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = agentsDir;
		Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		await closeDbAccessor();
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
	});

	afterEach(async () => {
		if (bridge !== null) {
			await bridge.close();
			bridge = null;
		}
		await waitForSourceIndexRuns();
		clearSourceIndexProgressForTests();
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		if (previousSignetAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = previousSignetAgentId;
		Bun.gc(true);
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("holds deletion through the real startup bridge run and purges its late writes", async () => {
		const added = addObsidianSource({ root: vault, name: "Startup bridge vault" }, agentsDir);
		if (added.ok === false) throw new Error(added.error);
		const source = added.source;
		const nativeSource = obsidianNativeMemorySource(vault, source.name, source.id, source.excludeGlobs);
		let indexedEvents = 0;
		const startupBridge = startNativeMemoryBridge([nativeSource], {
			agentsDir,
			agentId: "default",
			pollIntervalMs: 0,
			sourceCleanupEnabled: true,
			shouldCleanupSource: (candidate) => candidate.harness !== "obsidian",
			sourceGraphEnabled: true,
			workerOwnedIndexing: true,
			sourceFileDelayMs: 2_000,
			yieldEveryFiles: 1,
			onFileIndexed: (event) => {
				if (event.source.sourceId !== source.id) return;
				indexedEvents += 1;
			},
		});
		bridge = startupBridge;
		const job = beginSourceIndexJob(source.id, "source-startup");
		markSourceIndexInFlight(source.id);
		markSourceIndexJobRunning(source.id, job.id);
		const purges: number[] = [];
		const purgeNativeSource: typeof purgeNativeMemorySourceArtifacts = async (candidate, agentId) => {
			const purged = await purgeNativeMemorySourceArtifacts(candidate, agentId);
			purges.push(purged);
			return purged;
		};
		const activeRun = startupBridge
			.syncExisting()
			.then(() => undefined)
			.finally(async () => {
				await finalizeCancelledSourceIndexJob({
					source,
					jobId: job.id,
					agentsDir,
					agentId: "default",
					purgeNativeSource,
				});
				clearSourceIndexInFlight(source.id);
			});
		trackSourceIndexRun({ sourceId: source.id, jobId: job.id, kind: "startup", run: activeRun });

		await waitFor(() => indexedEvents > 0);
		const app = new Hono();
		registerSourcesRoutes(app, { agentsDir, purgeNativeSource });
		const indexedBeforeDelete = indexedEvents;
		const response = await app.request(`/api/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
		const body = (await response.json()) as { readonly cleanupPending?: boolean };
		const blockedMutation = beginSourceMutation(source.id);
		blockedMutation?.();

		await activeRun;
		await waitForSourceIndexRuns();
		await Bun.sleep(0);
		const releasedMutation = beginSourceMutation(source.id);
		releasedMutation?.();
		const remainingArtifacts = await purgeNativeMemorySourceArtifacts(nativeSource, "default");
		const tombstonePath = join(agentsDir, ".daemon", "source-deletion-tombstones.json");
		const tombstones = existsSync(tombstonePath)
			? (JSON.parse(readFileSync(tombstonePath, "utf8")) as readonly unknown[])
			: [];

		expect(response.status).toBe(200);
		expect(body.cleanupPending).toBe(true);
		expect(indexedEvents).toBeGreaterThan(1);
		expect(indexedEvents).toBeGreaterThan(indexedBeforeDelete);
		expect(blockedMutation).toBeUndefined();
		expect(releasedMutation).toBeFunction();
		expect(purges).toHaveLength(2);
		expect(remainingArtifacts).toBe(0);
		expect(tombstones).toHaveLength(0);
		expect(loadSourcesConfig(agentsDir).sources.some((candidate) => candidate.id === source.id)).toBe(false);
	}, 15_000);

	it("retains the tombstone when late startup cleanup fails", async () => {
		const added = addObsidianSource({ root: vault, name: "Startup cleanup retry vault" }, agentsDir);
		if (added.ok === false) throw new Error(added.error);
		const job = beginSourceIndexJob(added.source.id, "source-startup");
		markSourceIndexInFlight(added.source.id);
		markSourceIndexJobRunning(added.source.id, job.id);
		let releaseStartupRun = () => {};
		const startupGate = new Promise<void>((resolve) => {
			releaseStartupRun = resolve;
		});
		let purgeCalls = 0;
		const purgeNativeSource: typeof purgeNativeMemorySourceArtifacts = async () => {
			purgeCalls += 1;
			if (purgeCalls === 2) throw new Error("late purge failure");
			return 0;
		};
		const activeRun = startupGate.then(async () => {
			await finalizeCancelledSourceIndexJob({
				source: added.source,
				jobId: job.id,
				agentsDir,
				agentId: "default",
				purgeNativeSource,
			});
			clearSourceIndexInFlight(added.source.id);
		});
		trackSourceIndexRun({ sourceId: added.source.id, jobId: job.id, kind: "startup", run: activeRun });
		const app = new Hono();
		registerSourcesRoutes(app, { agentsDir, purgeNativeSource });
		const response = await app.request(`/api/sources/${encodeURIComponent(added.source.id)}`, { method: "DELETE" });
		const body = (await response.json()) as { readonly cleanupPending?: boolean };
		releaseStartupRun();
		await activeRun;
		await waitForSourceIndexRuns();
		await Bun.sleep(0);
		const releasedMutation = beginSourceMutation(added.source.id);
		releasedMutation?.();
		const tombstonePath = join(agentsDir, ".daemon", "source-deletion-tombstones.json");
		const tombstones = existsSync(tombstonePath)
			? (JSON.parse(readFileSync(tombstonePath, "utf8")) as readonly unknown[])
			: [];

		expect(response.status).toBe(200);
		expect(body.cleanupPending).toBe(true);
		expect(purgeCalls).toBe(2);
		expect(tombstones).toHaveLength(1);
		expect(releasedMutation).toBeFunction();
	}, 15_000);

	async function waitFor(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 500; attempt++) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for native startup indexing");
	}
});
