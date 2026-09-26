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
		const ontologyEntityId = "restore-ontology-entity";
		const ontologyAspectId = "restore-ontology-aspect";
		const ontologyOldAttributeId = "restore-ontology-claim-old";
		const ontologyAttributeId = "restore-ontology-claim";
		const ontologyAssertionId = "restore-ontology-assertion";
		const dreamingFrontier = JSON.stringify({
			capturedAt: "2026-01-01T00:00:00Z",
			kind: "transcript",
			id: "restore-frontier-session",
		});
		const consumedEvidence = "restore-consumed-transcript";
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
			database
				.prepare("INSERT INTO dreaming_state (agent_id, evidence_cursor) VALUES ('default', ?)")
				.run(dreamingFrontier);
			database
				.prepare(
					"INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES ('restore-pass', 'default', 'incremental-content', 'completed')",
				)
				.run();
			database
				.prepare(`INSERT INTO dreaming_evidence_consumption
				(agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision, delivered_offset, source_length, pass_id, updated_at)
				VALUES ('default', 'transcript', ?, '2026-01-01T00:00:00Z', ?, 'restore-revision', 12, 12, 'restore-pass', '2026-01-01T00:00:03Z')`)
				.run(transcriptKey, consumedEvidence);
			database
				.prepare(
					"INSERT INTO entities (id, name, entity_type, agent_id, created_at, updated_at) VALUES (?, 'Restore Lantern', 'object', 'default', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
				)
				.run(ontologyEntityId);
			database
				.prepare(
					"INSERT INTO entity_aspects (id, entity_id, name, canonical_name, agent_id) VALUES (?, ?, 'storage', 'storage', 'default')",
				)
				.run(ontologyAspectId, ontologyEntityId);
			database
				.prepare(`INSERT INTO entity_attributes
					(id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, group_key, claim_key, version, version_root_id, superseded_by, created_at, updated_at)
					VALUES (?, ?, 'default', 'attribute', 'Cobalt lantern was kept in bay seven.', 'cobalt lantern was kept in bay seven', 0.9, 0.8, 'superseded', 'restore-fixture', 'cobalt_lantern_in_bay_seven', 1, ?, ?, '2025-12-31T00:00:00Z', '2026-01-01T00:00:00Z')`)
				.run(ontologyOldAttributeId, ontologyAspectId, ontologyOldAttributeId, ontologyAttributeId);
			database
				.prepare(`INSERT INTO entity_attributes
					(id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, group_key, claim_key, version, version_root_id, previous_attribute_id, created_at, updated_at)
					VALUES (?, ?, 'default', 'attribute', 'Cobalt lantern is stored in bay seven.', 'cobalt lantern in bay seven', 0.9, 0.8, 'active', 'restore-fixture', 'cobalt_lantern_in_bay_seven', 2, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
				.run(ontologyAttributeId, ontologyAspectId, ontologyOldAttributeId, ontologyOldAttributeId);
			database
				.prepare(`INSERT INTO epistemic_assertions
				(id, agent_id, subject_entity_id, claim_attribute_id, predicate, content, normalized_content, asserted_at, confidence, status, source_kind, source_id, evidence, created_at, updated_at)
				VALUES (?, 'default', ?, ?, 'claims', 'Cobalt lantern is stored in bay seven.', 'cobalt lantern is stored in bay seven', '2026-01-01T00:00:00Z', 0.9, 'active', 'transcript', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
				.run(
					ontologyAssertionId,
					ontologyEntityId,
					ontologyAttributeId,
					transcriptKey,
					JSON.stringify([
						{
							source_ref: `transcript:${transcriptKey}`,
							quote: "the cobalt lantern is stored in bay seven.",
						},
					]),
				);
		} finally {
			database.close();
		}
		let queriedDaemon = false;
		let queriedDatabase = false;
		let queriedDreaming = false;
		let queriedMemory = false;
		let queriedOntology = false;
		let probeFailureMessage = "";
		let tracedVersions: string[] = [];
		let tracedEvidence: unknown = null;
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
				dreaming: { frontier: dreamingFrontier, consumed: [consumedEvidence] },
				ontology: { history: 2, evidenceLinks: 1 },
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
					const dreaming = restoredDatabase
						.prepare("SELECT evidence_cursor FROM dreaming_state WHERE agent_id = 'default'")
						.get() as { evidence_cursor: string } | null;
					const consumed = restoredDatabase
						.prepare("SELECT source_entry_id FROM dreaming_evidence_consumption WHERE pass_id = 'restore-pass'")
						.get() as { source_entry_id: string } | null;
					queriedDreaming =
						dreaming?.evidence_cursor === dreamingFrontier && consumed?.source_entry_id === consumedEvidence;
					const ontology = restoredDatabase
						.prepare(
							"SELECT a.id, COUNT(ea.id) AS evidence_links FROM entity_attributes a LEFT JOIN epistemic_assertions ea ON ea.claim_attribute_id = a.id WHERE a.id = ? GROUP BY a.id",
						)
						.get(ontologyAttributeId) as { id: string; evidence_links: number } | null;
					const history = restoredDatabase
						.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE aspect_id = ?")
						.get(ontologyAspectId) as { count: number } | null;
					const evidence = restoredDatabase
						.prepare("SELECT id FROM epistemic_assertions WHERE subject_entity_id = ? AND claim_attribute_id = ?")
						.get(ontologyEntityId, ontologyAttributeId) as { id: string } | null;
					queriedOntology =
						ontology?.id === ontologyAttributeId &&
						ontology.evidence_links === 1 &&
						history?.count === 2 &&
						evidence?.id === ontologyAssertionId;
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
				const dreamingResponse = await fetch(`http://127.0.0.1:${port}/api/dream/status?agent_id=default`, {
					signal: AbortSignal.timeout(5000),
				});
				if (!dreamingResponse.ok)
					throw Object.assign(new Error("restored dreaming state unavailable"), { component: "dreaming" });
				const dreamingBody = (await dreamingResponse.json()) as {
					state?: { evidenceCursor?: unknown; lastPassId?: string };
				};
				if (JSON.stringify(dreamingBody.state?.evidenceCursor) !== dreamingFrontier)
					throw Object.assign(new Error("restored dreaming frontier mismatch"), { component: "dreaming" });
				const ontologyResponse = await fetch(
					`http://127.0.0.1:${port}/api/ontology/claims/explain?entity=Restore%20Lantern&aspect=storage&group=restore-fixture&claim=cobalt%20lantern%20in%20bay%20seven&agent_id=default`,
					{
						signal: AbortSignal.timeout(5000),
					},
				);
				if (!ontologyResponse.ok) {
					probeFailureMessage = `restored ontology history unavailable (${ontologyResponse.status}): ${(await ontologyResponse.text()).slice(0, 240)}`;
					throw Object.assign(new Error(probeFailureMessage), { component: "ontology" });
				}
				const ontologyBody = (await ontologyResponse.json()) as {
					versions?: { items?: Array<{ attribute: { id: string } }> };
					premises?: { items?: Array<{ evidence: unknown }> };
				};
				tracedVersions = ontologyBody.versions?.items?.map(({ attribute }) => attribute.id) ?? [];
				tracedEvidence = ontologyBody.premises?.items?.[0]?.evidence ?? null;
				if (
					!JSON.stringify(ontologyBody).includes(ontologyAttributeId) ||
					!JSON.stringify(ontologyBody).includes(ontologyAssertionId)
				)
					throw Object.assign(new Error("restored ontology claim or evidence link mismatch"), {
						component: "ontology",
					});
				const skillsResponse = await fetch(`http://127.0.0.1:${port}/api/skills`, {
					signal: AbortSignal.timeout(3000),
				});
				if (!skillsResponse.ok) throw new Error(`restored skills unavailable: ${skillsResponse.status}`);
				const skillsBody = (await skillsResponse.json()) as { skills: Array<{ name: string }> };
				return {
					database: { snapshotConsistent: queriedDatabase },
					observed: {
						dreaming: {
							frontier: queriedDreaming ? JSON.stringify(dreamingBody.state?.evidenceCursor) : "",
							consumed: queriedDreaming ? [consumedEvidence] : [],
						},
						ontology: {
							history: queriedOntology ? 2 : 0,
							evidenceLinks: queriedOntology ? 1 : 0,
						},
						sources: body.sources.map(({ id, generation }) => ({ id, generation: generation ?? "" })),
						harness: {
							identity: status.agentId,
							skills: skillsBody.skills.filter(({ name }) => name === "independent").map(({ name }) => name),
						},
					},
				};
			},
		});
		expect(probeFailureMessage).toBe("");
		expect(queriedDaemon).toBe(true);
		expect(queriedDatabase).toBe(true);
		expect(queriedMemory).toBe(true);
		expect(queriedOntology).toBe(true);
		expect(tracedVersions).toEqual([ontologyAttributeId, ontologyOldAttributeId]);
		expect(tracedEvidence).toMatchObject({
			state: "available",
			exactQuote: "the cobalt lantern is stored in bay seven.",
		});
		expect(queriedDreaming).toBe(true);
		expect(result.failures.map((failure) => failure.component)).not.toContain("daemon");
		expect(result.failures.map((failure) => failure.component)).not.toContain("database");
		expect(result.failures.map((failure) => failure.component)).not.toContain("sources");
		expect(result.failures.map((failure) => failure.component)).not.toContain("transcripts");
		expect(result.failures.map((failure) => failure.component)).not.toContain("harness");
		expect(result.ok).toBe(false);
		expect(result.failures.map((failure) => failure.component)).not.toContain("dreaming");
		expect(result.failures.map((failure) => failure.component)).not.toContain("ontology");
		for (const component of ["recall", "protection"]) {
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
