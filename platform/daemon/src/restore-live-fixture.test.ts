import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { executeDisposableRestore } from "./restore-verification";

it("starts the real daemon on a restored v2 database and reads persisted state independently", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-live-restore-"));
	try {
		const snapshot = join(root, "snapshot");
		mkdirSync(join(snapshot, "data"), { recursive: true });
		writeFileSync(join(snapshot, "workspace-layout.json"), JSON.stringify({ version: 2 }));
		writeFileSync(join(snapshot, "agent.yaml"), "embedding:\n  provider: none\n");
		mkdirSync(join(snapshot, "skills", "independent"), { recursive: true });
		writeFileSync(
			join(snapshot, "skills", "independent", "SKILL.md"),
			"---\nname: independent\ndescription: Restored skill\n---\n",
		);
		const external = join(root, "external-source");
		mkdirSync(external);
		writeFileSync(
			join(snapshot, "sources.json"),
			JSON.stringify({
				version: 1,
				sources: [
					{
						id: "source-1",
						generation: "generation-3",
						kind: "obsidian",
						name: "External",
						root: external,
						enabled: true,
						mode: "read-only",
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				],
			}),
		);
		const dbPath = join(snapshot, "data", "signet.db");
		initDbAccessor(dbPath, { agentsDir: snapshot });
		await closeDbAccessor();
		const database = new Database(dbPath);
		try {
			database.exec("CREATE TABLE restore_witness (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
			database.prepare("INSERT INTO restore_witness VALUES (?, ?)").run("snapshot-row", "persisted-before-restore");
			database
				.prepare(
					"INSERT INTO memories (id, content, type, agent_id, visibility, created_at, updated_at, updated_by) VALUES (?, ?, 'fact', 'default', 'global', datetime('now'), datetime('now'), 'test')",
				)
				.run("snapshot-memory", "persisted memory from the snapshot");
		} finally {
			database.close();
		}
		let queriedDaemon = false;
		let queriedDatabase = false;
		let queriedMemory = false;
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected: {
				files: ["workspace-layout.json", "agent.yaml", "data/signet.db", "sources.json", "skills/independent/SKILL.md"],
				transcripts: [],
				sources: [{ id: "source-1", generation: "generation-3" }],
				recall: { current: true, scope: "default" },
				dreaming: { frontier: "", consumed: [] },
				ontology: { history: 0, evidenceLinks: 0 },
				harness: { identity: "default", skills: ["independent"] },
			},
			daemon: {
				binary: process.execPath,
				args: [join(import.meta.dir, "daemon.ts")],
				env: {
					...buildHermeticEnvironment({ PATH: process.env.PATH, LANG: "C.UTF-8" }, join(root, "isolation")),
					SIGNET_EMBEDDING_WARM_NATIVE: "false",
					SIGNET_TELEMETRY_OPTOUT: "1",
					SIGNET_ANALYTICS_DISABLED: "1",
				},
			},
			probe: async (restored, port) => {
				const response = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(3000) });
				queriedDaemon = response.ok && ((await response.json()) as { status: string }).status === "healthy";
				const restoredDatabase = new Database(join(restored, "data", "signet.db"), { readonly: true });
				try {
					const row = restoredDatabase
						.prepare("SELECT value FROM restore_witness WHERE id = ?")
						.get("snapshot-row") as { value: string } | null;
					const integrity = restoredDatabase.query("PRAGMA quick_check").get() as { quick_check: string };
					queriedDatabase = row?.value === "persisted-before-restore" && integrity.quick_check === "ok";
				} finally {
					restoredDatabase.close();
				}
				const sourceResponse = await fetch(`http://127.0.0.1:${port}/api/sources`, {
					signal: AbortSignal.timeout(3000),
				});
				if (!sourceResponse.ok) throw new Error(`restored sources unavailable: ${sourceResponse.status}`);
				const body = (await sourceResponse.json()) as { sources: Array<{ id: string; generation?: string }> };
				const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`, {
					signal: AbortSignal.timeout(5000),
				});
				if (!statusResponse.ok) throw new Error(`restored status unavailable: ${statusResponse.status}`);
				const status = (await statusResponse.json()) as { agentId: string; agentsDir: string; memoryDb: boolean };
				queriedDaemon = queriedDaemon && status.agentsDir === restored && status.memoryDb;
				const memoryResponse = await fetch(`http://127.0.0.1:${port}/api/memory/snapshot-memory`, {
					signal: AbortSignal.timeout(3000),
				});
				queriedMemory =
					memoryResponse.ok &&
					((await memoryResponse.json()) as { content?: string }).content === "persisted memory from the snapshot";
				const skillsResponse = await fetch(`http://127.0.0.1:${port}/api/skills`, {
					signal: AbortSignal.timeout(3000),
				});
				if (!skillsResponse.ok) throw new Error(`restored skills unavailable: ${skillsResponse.status}`);
				const skillsBody = (await skillsResponse.json()) as { skills: Array<{ name: string }> };
				return {
					database: { snapshotConsistent: queriedDatabase },
					observed: {
						sources: body.sources.map(({ id, generation }) => ({ id, generation: generation ?? "" })),
						harness: {
							identity: status.agentId,
							skills: skillsBody.skills.filter(({ name }) => name === "independent").map(({ name }) => name),
						},
					},
				};
			},
		});
		expect(queriedDaemon).toBe(true);
		expect(queriedDatabase).toBe(true);
		expect(queriedMemory).toBe(true);
		expect(result.failures.map((failure) => failure.component)).not.toContain("daemon");
		expect(result.failures.map((failure) => failure.component)).not.toContain("database");
		expect(result.failures.map((failure) => failure.component)).not.toContain("sources");
		expect(result.failures.map((failure) => failure.component)).not.toContain("harness");
		expect(result.ok).toBe(false);
		for (const component of ["recall", "dreaming", "ontology", "protection"]) {
			expect(result.failures.map((failure) => failure.component)).toContain(component);
		}
		expect(result.receipt.ok).toBe(false);
		expect(result.failures.map((failure) => failure.component)).toContain("protection");
		expect(existsSync(join(snapshot, ".signet", "restore-receipt.json"))).toBe(false);
		expect(result.cleaned).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
