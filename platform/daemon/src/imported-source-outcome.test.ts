import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { persistImportedSourceOutcomeInTx, readImportedSourceOutcome } from "./imported-source-outcome";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { indexSourceArtifactStructureInTx } from "./source-artifact-graph";

describe("imported source outcomes", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-import-outcome-"));
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("rolls back graph extraction and its durable outcome after an injected pre-commit crash across restart", () => {
		const agentId = "import-outcome-test-agent";
		const sourceId = "import:test";
		const sourcePath = "imports/import:test/atomic.md";
		const dbPath = join(dir, "memory", "memories.db");
		indexExternalMemoryArtifact({
			agentId,
			sourceId,
			sourcePath,
			sourceKind: "source_import_markdown",
			sourceRoot: "atomic.md",
			harness: "dashboard-import",
			content: "# Atomic import\n\nThe outcome must commit with the graph extraction or not at all.\n",
			sourceMtimeMs: Date.now(),
		});

		expect(() =>
			getDbAccessor().withWriteTx((db) => {
				const extraction = indexSourceArtifactStructureInTx(db, {
					agentId,
					sourceId,
					sourceKind: "source_import_markdown",
					sourceRoot: "atomic.md",
					sourcePath,
					displayName: "atomic.md",
					content: "# Atomic import\n\nThe outcome must commit with the graph extraction or not at all.\n",
				});
				persistImportedSourceOutcomeInTx(db, {
					agentId,
					sourceId,
					sourcePath,
					outcome: {
						documentEntityId: extraction.documentEntityId,
						aspectsCreated: extraction.aspectsCreated,
						attributesCreated: extraction.attributesCreated,
					},
				});
				throw new Error("fault injection: crash before import extraction transaction commit");
			}),
		).toThrow("fault injection");

		closeDbAccessor();
		initDbAccessor(dbPath);

		expect(readImportedSourceOutcome(sourceId, agentId)).toBeUndefined();
		const rows = getDbAccessor().withReadDb((db) => ({
			entities: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ? AND source_id = ?")
					.get(agentId, sourceId) as {
					count: number;
				}
			).count,
			aspects: (
				db.prepare("SELECT COUNT(*) AS count FROM entity_aspects WHERE agent_id = ?").get(agentId) as {
					count: number;
				}
			).count,
			attributes: (
				db
					.prepare("SELECT COUNT(*) AS count FROM entity_attributes WHERE agent_id = ? AND source_id = ?")
					.get(agentId, sourceId) as {
					count: number;
				}
			).count,
			artifactMeta: (
				db
					.prepare(
						"SELECT source_meta_json FROM memory_artifacts WHERE agent_id = ? AND source_id = ? AND source_path = ?",
					)
					.get(agentId, sourceId, sourcePath) as { source_meta_json: string | null }
			).source_meta_json,
		}));
		expect(rows.entities).toBe(0);
		expect(rows.aspects).toBe(0);
		expect(rows.attributes).toBe(0);
		expect(JSON.parse(rows.artifactMeta ?? "{}")).not.toHaveProperty("importExtraction");
	});
});
