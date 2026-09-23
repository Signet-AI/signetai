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
		const transcriptPath = join(snapshot, "transcripts", "fixture.jsonl");
		mkdirSync(join(snapshot, "transcripts"), { recursive: true });
		const transcriptRows = [
			{
				role: "user",
				content: "Remember the cobalt lantern is stored in bay seven.",
				timestamp: "2026-01-01T00:00:00Z",
				provenance: "fixture-user",
			},
			{
				role: "assistant",
				content: "I will remember: the cobalt lantern is stored in bay seven.",
				timestamp: "2026-01-01T00:00:01Z",
				provenance: "fixture-assistant",
			},
		];
		writeFileSync(transcriptPath, `${transcriptRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		const dbPath = join(snapshot, "data", "signet.db");
		initDbAccessor(dbPath, { agentsDir: snapshot });
		await closeDbAccessor();
		const memoryId = "snapshot-memory";
		const memoryContent = "The cobalt lantern is stored in bay seven.";
		const isolatedMemoryId = "isolated-memory";
		const isolatedContent = "Only agent isolated-agent may recall the cedar compass in locker nine.";
		const transcriptKey = "restored-completed-session";
		const transcriptContent = transcriptRows
			.map(({ role, content }) => `${role === "user" ? "User" : "Assistant"}: ${content}`)
			.join("\n");
		const database = new Database(dbPath);
		try {
			database.exec("CREATE TABLE restore_witness (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
			database.prepare("INSERT INTO restore_witness VALUES (?, ?)").run("snapshot-row", "persisted-before-restore");
			database
				.prepare(
					"INSERT INTO memories (id, content, type, agent_id, visibility, created_at, updated_at, updated_by) VALUES (?, ?, 'fact', 'default', 'global', datetime('now'), datetime('now'), 'test')",
				)
				.run(memoryId, memoryContent);
			database
				.prepare(
					"INSERT INTO memories (id, content, type, agent_id, visibility, created_at, updated_at, updated_by) VALUES (?, ?, 'fact', 'isolated-agent', 'private', datetime('now'), datetime('now'), 'test')",
				)
				.run(isolatedMemoryId, isolatedContent);
			database
				.prepare(
					"INSERT INTO session_transcripts (session_key, content, harness, agent_id, created_at, updated_at, completed_at) VALUES (?, ?, 'restore-fixture', 'default', ?, ?, ?)",
				)
				.run(transcriptKey, transcriptContent, "2026-01-01T00:00:00Z", "2026-01-01T00:00:02Z", "2026-01-01T00:00:02Z");
		} finally {
			database.close();
		}
		let queriedDaemon = false;
		let queriedDatabase = false;
		let queriedMemory = false;
		const result = await executeDisposableRestore({
			snapshotRoot: snapshot,
			expected: {
				files: [
					"workspace-layout.json",
					"agent.yaml",
					"data/signet.db",
					"sources.json",
					"skills/independent/SKILL.md",
					"transcripts/fixture.jsonl",
				],
				transcripts: [
					{
						path: "transcripts/fixture.jsonl",
						roles: ["user", "assistant"],
						provenance: ["fixture-user", "fixture-assistant"],
					},
				],
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
				const memoryResponse = await fetch(`http://127.0.0.1:${port}/api/memory/${encodeURIComponent(memoryId)}`, {
					signal: AbortSignal.timeout(3000),
				});
				queriedMemory =
					memoryResponse.ok && ((await memoryResponse.json()) as { content?: string }).content === memoryContent;
				const transcriptResponse = await fetch(
					`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(transcriptKey)}/transcript?agent_id=default`,
					{ signal: AbortSignal.timeout(3000) },
				);
				if (!transcriptResponse.ok)
					throw Object.assign(new Error("restored transcript unavailable"), { component: "transcripts" });
				const transcriptBody = (await transcriptResponse.json()) as { content: string };
				const parsedTranscript = transcriptBody.content.split("\n").map((line) => {
					const separator = line.indexOf(": ");
					return { role: line.slice(0, separator).toLowerCase(), content: line.slice(separator + 2) };
				});
				if (
					JSON.stringify(parsedTranscript) !==
					JSON.stringify(transcriptRows.map(({ role, content }) => ({ role, content })))
				)
					throw Object.assign(new Error("restored transcript fidelity mismatch"), { component: "transcripts" });
				const recallResponse = await fetch(`http://127.0.0.1:${port}/api/memory/recall`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ query: "cobalt lantern bay seven", agentId: "default", limit: 10 }),
					signal: AbortSignal.timeout(5000),
				});
				if (!recallResponse.ok)
					throw Object.assign(new Error("current-agent recall unavailable"), { component: "recall" });
				const recallBody = (await recallResponse.json()) as {
					results?: Array<{ id: string; content: string; agent_id?: string }>;
				};
				const recalled =
					recallBody.results?.some(({ id, content }) => id === memoryId && content === memoryContent) === true;
				const isolatedRecall = await fetch(`http://127.0.0.1:${port}/api/memory/recall`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ query: "cedar compass locker nine", agentId: "default", limit: 10 }),
					signal: AbortSignal.timeout(5000),
				});
				if (!isolatedRecall.ok)
					throw Object.assign(new Error("cross-agent recall probe unavailable"), { component: "recall" });
				const isolatedBody = (await isolatedRecall.json()) as { results?: Array<{ id: string; content: string }> };
				const leaked =
					isolatedBody.results?.some(({ id, content }) => id === isolatedMemoryId || content === isolatedContent) ===
					true;
				if (!recalled || leaked)
					throw Object.assign(new Error("persisted-memory recall scope mismatch"), { component: "recall" });
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
		expect(result.failures.map((failure) => failure.component)).not.toContain("transcripts");
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
