import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { markImportedSourceUnsupported } from "./imported-source-lifecycle";
import { propagateMemoryStatus } from "./knowledge-graph";
import { DEFAULT_PIPELINE_V2 } from "./memory-config";
import { getOntologyContradiction, listOntologyContradictions } from "./ontology-contradictions";
import { applyOntologyOperation } from "./ontology-proposals";
import { createDreamingCapabilities } from "./pipeline/dreaming-capabilities";
import { registerOntologyRoutes } from "./routes/ontology-routes";
import { createRateLimiter, pruneGenericEntities } from "./repair-actions";
import { purgeSourceOwnedRows } from "./source-purge";

describe("persisted ontology contradictions", () => {
	let dir = "";
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-ontology-contradictions-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "name: OntologyContradictionTest\n");
		previousSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	});

	afterEach(async () => {
		await closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	async function addClaim(agentId: string, value: string, sourceId: string, sourceKind = "fixture") {
		return applyOntologyOperation(getDbAccessor(), {
			agentId,
			actor: "contradiction-test",
			operation: "add_claim_value",
			payload: {
				entity: "Runtime",
				entity_type: "system",
				aspect: "configuration",
				group_key: "runtime",
				claim_key: "default_mode",
				value,
			},
			evidence: [{ quote: value, source_id: sourceId }],
			sourceKind,
			sourceId,
			sourcePath: `fixtures/${sourceId}.json`,
		});
	}

	async function setClaim(agentId: string, value: string, sourceId: string) {
		return applyOntologyOperation(getDbAccessor(), {
			agentId,
			actor: "contradiction-test",
			operation: "set_claim_value",
			payload: {
				entity: "Runtime",
				entity_type: "system",
				aspect: "configuration",
				group_key: "runtime",
				claim_key: "default_mode",
				value,
			},
			evidence: [{ quote: value, source_id: sourceId }],
			sourceKind: "fixture",
			sourceId,
			sourcePath: `fixtures/${sourceId}.json`,
		});
	}

	async function supersedeClaim(agentId: string, oldValue: string, newValue: string, sourceId: string) {
		return applyOntologyOperation(getDbAccessor(), {
			agentId,
			actor: "contradiction-test",
			operation: "supersede_claim_value",
			payload: {
				entity: "Runtime",
				entity_type: "system",
				aspect: "configuration",
				group_key: "runtime",
				claim_key: "default_mode",
				old_value: oldValue,
				new_value: newValue,
			},
			evidence: [{ quote: newValue, source_id: sourceId }],
			sourceKind: "fixture",
			sourceId,
			sourcePath: `fixtures/${sourceId}.json`,
		});
	}

	function storedStatuses(agentId: string): Array<{ status: string; updated_at: string }> {
		return getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT status, updated_at FROM ontology_contradictions WHERE agent_id = ? ORDER BY id")
					.all(agentId) as Array<{ status: string; updated_at: string }>,
		);
	}

	async function seedContradiction(): Promise<string> {
		await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled");
		expect(storedStatuses("owner").map((row) => row.status)).toEqual(["active"]);
		const attributeId = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare("SELECT id FROM entity_attributes WHERE agent_id = ? AND source_id = ?")
						.get("owner", "source-enabled") as { id: string } | null
				)?.id,
		);
		if (attributeId === undefined) throw new Error("expected enabled claim fixture");
		return attributeId;
	}

	it("reads contradictions without reconciling them", async () => {
		const attributeId = await seedContradiction();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entity_attributes SET status = 'archived' WHERE id = ?").run(attributeId);
		});
		const before = storedStatuses("owner");

		const listed = listOntologyContradictions(getDbAccessor(), { agentId: "owner" });
		const contradiction = listed.items[0];
		if (!contradiction) throw new Error("expected contradiction fixture");
		expect(getOntologyContradiction(getDbAccessor(), { agentId: "owner", id: contradiction.id })?.status).toBe(
			"active",
		);
		expect(storedStatuses("owner")).toEqual(before);
	});

	it("reconciles when imported-source lifecycle archives a competing claim", async () => {
		await seedContradiction();
		markImportedSourceUnsupported({ agentId: "owner", sourceId: "source-enabled" });
		expect(storedStatuses("owner").map((row) => row.status)).toEqual(["resolved"]);
	});

	it("reconciles when memory status propagation supersedes a competing claim", async () => {
		const attributeId = await seedContradiction();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE memories SET is_deleted = 1 WHERE id = (SELECT memory_id FROM entity_attributes WHERE id = ?)",
			).run(attributeId);
		});
		expect(await propagateMemoryStatus(getDbAccessor(), "owner")).toBeGreaterThan(0);
		expect(storedStatuses("owner").map((row) => row.status)).toEqual(["resolved"]);
	});

	it("reconciles when generic entity repair deletes the contested entity", async () => {
		await seedContradiction();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET name = 'Sender', canonical_name = 'sender' WHERE agent_id = ? AND name = ?").run(
				"owner",
				"Runtime",
			);
		});
		const result = await pruneGenericEntities(
			getDbAccessor(),
			{ ...DEFAULT_PIPELINE_V2, shadowMode: false, mutationsFrozen: false },
			{ reason: "test run", actor: "test-operator", actorType: "operator" },
			createRateLimiter(),
			{ agentId: "owner", dryRun: false },
		);
		expect(result.success).toBe(true);
		expect(result.affected).toBe(1);
		expect(storedStatuses("owner").map((row) => row.status)).toEqual(["resolved"]);
	});

	it("records set-claim contradiction evidence before governance supersedes the prior value", async () => {
		await setClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		const result = await setClaim("owner", "Runtime mode is disabled by default.", "source-disabled");

		expect(result.result?.contradictionIds).toEqual([expect.any(String)]);
		const all = await listOntologyContradictions(getDbAccessor(), { agentId: "owner", status: "all" });
		expect(all.items).toHaveLength(1);
		expect(all.items[0]?.status).toBe("resolved");
		expect([all.items[0]?.leftSourceId, all.items[0]?.rightSourceId]).toEqual(
			expect.arrayContaining(["source-enabled", "source-disabled"]),
		);
		expect([...(all.items[0]?.leftEvidence ?? []), ...(all.items[0]?.rightEvidence ?? [])]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source_id: "source-enabled" }),
				expect.objectContaining({ source_id: "source-disabled" }),
			]),
		);
		expect((await listOntologyContradictions(getDbAccessor(), { agentId: "owner" })).items).toHaveLength(0);
	});

	it("records supersede-claim contradiction evidence atomically with replacement", async () => {
		await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		const result = await supersedeClaim(
			"owner",
			"Runtime mode is enabled by default.",
			"Runtime mode is disabled by default.",
			"source-disabled",
		);

		expect(result.result?.replacementCreated).toBe(true);
		const all = await listOntologyContradictions(getDbAccessor(), { agentId: "owner", status: "all" });
		expect(all.items).toHaveLength(1);
		expect(all.items[0]?.status).toBe("resolved");
		expect([all.items[0]?.leftSourceId, all.items[0]?.rightSourceId]).toEqual(
			expect.arrayContaining(["source-enabled", "source-disabled"]),
		);
		expect((await listOntologyContradictions(getDbAccessor(), { agentId: "owner" })).items).toHaveLength(0);
	});

	it("keeps idempotent and non-contradictory set writes out of the ledger", async () => {
		const first = await setClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		const duplicate = await setClaim("owner", "Runtime mode is enabled by default.", "source-enabled");

		expect(first.result?.contradictionIds).toEqual([]);
		expect(duplicate.result?.deduped).toBe(true);
		expect(duplicate.result?.contradictionIds).toEqual([]);
		expect((await listOntologyContradictions(getDbAccessor(), { agentId: "owner", status: "all" })).items).toHaveLength(
			0,
		);
	});

	it("rolls back set-claim mutation when contradiction ledger insertion fails", async () => {
		await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		getDbAccessor().withWriteTx((db) => {
			db.exec(`
				CREATE TRIGGER fail_ontology_contradiction_insert
				BEFORE INSERT ON ontology_contradictions
				BEGIN
					SELECT RAISE(ABORT, 'ledger write failed');
				END;
			`);
		});

		await expect(setClaim("owner", "Runtime mode is disabled by default.", "source-disabled")).rejects.toThrow(
			"ledger write failed",
		);
		const active = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT content FROM entity_attributes
						 WHERE agent_id = ? AND status = 'active' AND claim_key = ?`,
					)
					.all("owner", "default_mode") as Array<{ content: string }>,
		);
		expect(active).toEqual([{ content: "Runtime mode is enabled by default." }]);
		expect((await listOntologyContradictions(getDbAccessor(), { agentId: "owner", status: "all" })).items).toHaveLength(
			0,
		);
	});

	it("persists one evidence-linked observation for competing active claims", async () => {
		const left = await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled", "authoritative");
		const leftAttributeId = left.result?.attributeId;
		if (typeof leftAttributeId !== "string") throw new Error("expected left claim fixture");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET scope = ?, visibility = ? WHERE id = ? AND agent_id = ?").run(
				"project:runtime",
				"private",
				leftAttributeId,
				"owner",
			);
		});
		const right = await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled", "unverified");
		await addClaim("other", "Runtime mode is enabled by default.", "other-enabled");

		const active = await listOntologyContradictions(getDbAccessor(), { agentId: "owner" });
		expect(active.count).toBe(1);
		expect(active.items).toHaveLength(1);
		const contradiction = active.items[0];
		if (!contradiction) throw new Error("expected contradiction fixture");
		expect(contradiction).toMatchObject({
			agentId: "owner",
			entityName: "Runtime",
			aspectName: "configuration",
			groupKey: "runtime",
			claimKey: "default_mode",
			detector: "lexical",
			status: "active",
		});
		expect([contradiction.leftSourceKind, contradiction.rightSourceKind]).toEqual(
			expect.arrayContaining(["authoritative", "unverified"]),
		);
		expect([contradiction.leftScope, contradiction.rightScope]).toEqual(
			expect.arrayContaining(["project:runtime", null]),
		);
		expect([contradiction.leftVisibility, contradiction.rightVisibility]).toEqual(
			expect.arrayContaining(["private", "global"]),
		);
		expect([contradiction.leftContent, contradiction.rightContent]).toEqual(
			expect.arrayContaining(["Runtime mode is enabled by default.", "Runtime mode is disabled by default."]),
		);
		expect([contradiction.leftSourceId, contradiction.rightSourceId]).toEqual(
			expect.arrayContaining(["source-enabled", "source-disabled"]),
		);
		expect(contradiction.leftEvidence).toEqual(
			expect.arrayContaining([expect.objectContaining({ quote: expect.any(String) })]),
		);
		expect(contradiction.rightEvidence).toEqual(
			expect.arrayContaining([expect.objectContaining({ quote: expect.any(String) })]),
		);
		expect([left.result?.attributeId, right.result?.attributeId]).toEqual(
			expect.arrayContaining([contradiction.leftAttributeId, contradiction.rightAttributeId]),
		);

		const other = await listOntologyContradictions(getDbAccessor(), { agentId: "other" });
		expect(other.items).toHaveLength(0);
		const duplicate = await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled");
		expect(duplicate.result?.deduped).toBe(true);
		expect((await listOntologyContradictions(getDbAccessor(), { agentId: "owner" })).count).toBe(1);
	});

	it("resolves source removal while retaining snapshots and provenance", async () => {
		await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled");

		await purgeSourceOwnedRows({ agentId: "owner", sourceId: "source-enabled" });

		const all = await listOntologyContradictions(getDbAccessor(), { agentId: "owner", status: "all" });
		expect(all.items).toHaveLength(1);
		expect(all.items[0]).toMatchObject({
			status: "resolved",
			resolutionReason: "one competing claim is no longer active",
			leftContent: expect.any(String),
			rightContent: expect.any(String),
		});
		expect([all.items[0]?.leftSourceId, all.items[0]?.rightSourceId]).toEqual(
			expect.arrayContaining(["source-enabled", "source-disabled"]),
		);
		expect((await listOntologyContradictions(getDbAccessor(), { agentId: "owner" })).items).toHaveLength(0);
	});

	it("keeps current-claim governance separate from contradiction state", async () => {
		await applyOntologyOperation(getDbAccessor(), {
			agentId: "owner",
			actor: "contradiction-test",
			operation: "set_claim_value",
			payload: {
				entity: "Runtime",
				entity_type: "system",
				aspect: "configuration",
				group_key: "runtime",
				claim_key: "default_mode",
				value: "Runtime mode is enabled by default.",
			},
			sourceKind: "fixture",
			sourceId: "source-enabled",
		});
		await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled");

		const activeBeforeSet = await listOntologyContradictions(getDbAccessor(), { agentId: "owner" });
		expect(activeBeforeSet.items).toHaveLength(1);
		await applyOntologyOperation(getDbAccessor(), {
			agentId: "owner",
			actor: "contradiction-test",
			operation: "set_claim_value",
			payload: {
				entity: "Runtime",
				entity_type: "system",
				aspect: "configuration",
				group_key: "runtime",
				claim_key: "default_mode",
				value: "Runtime mode is automatic by default.",
			},
			sourceKind: "fixture",
			sourceId: "source-automatic",
		});

		const all = await listOntologyContradictions(getDbAccessor(), { agentId: "owner", status: "all" });
		expect(all.items).toHaveLength(1);
		expect(all.items[0]?.status).toBe("resolved");
		const activeClaims = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT content FROM entity_attributes
						 WHERE agent_id = ? AND status = 'active' AND claim_key = ?
						 ORDER BY content`,
					)
					.all("owner", "default_mode") as Array<{ content: string }>,
		);
		expect(activeClaims).toEqual([{ content: "Runtime mode is automatic by default." }]);
	});

	it("exposes scoped contradiction reads through the recall-authorized route", async () => {
		await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled");
		const contradiction = (await listOntologyContradictions(getDbAccessor(), { agentId: "owner" })).items[0];
		if (!contradiction) throw new Error("expected contradiction fixture");

		const app = new Hono();
		registerOntologyRoutes(app);
		const listResponse = await app.request("/api/ontology/contradictions?agent_id=owner");
		expect(listResponse.status).toBe(200);
		expect((await listResponse.json()) as { readonly count?: number }).toMatchObject({ count: 1 });

		const crossAgentResponse = await app.request(`/api/ontology/contradictions/${contradiction.id}?agent_id=other`);
		expect(crossAgentResponse.status).toBe(404);
	});

	it("makes persisted observations available to the scoped Dreaming reader", async () => {
		const first = await addClaim("owner", "Runtime mode is enabled by default.", "source-enabled");
		await addClaim("owner", "Runtime mode is disabled by default.", "source-disabled");
		const capability = createDreamingCapabilities({
			accessor: getDbAccessor(),
			agentId: "owner",
			actor: "dreaming-test",
		}).find((item) => item.id === "list_aspect_claims");
		if (!capability) throw new Error("list_aspect_claims capability was not registered");

		const result = await capability.invoke({
			agentId: "owner",
			entityId: first.result?.entityId,
			aspectId: first.result?.aspectId,
			include: ["contradictions"],
		});
		expect(result).toMatchObject({ ok: true, contradictions: { count: 1 } });
	});
});
