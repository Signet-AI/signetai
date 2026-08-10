/**
 * Fixed-input evaluation for the authorized ontology claim trace (#1318).
 *
 * Run with:
 *   bun scripts/claim-trace-eval.ts
 *
 * The fixture is intentionally local and deterministic. It exercises the
 * operation directly, so the metric measures the canonical trace rather than
 * a renderer or a network server.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../platform/daemon/src/db-accessor";
import { createEpistemicAssertionsInTx } from "../platform/daemon/src/ontology-assertions";
import {
	type ClaimTraceResult,
	OntologyClaimTraceError,
	explainOntologyClaim,
} from "../platform/daemon/src/ontology-claim-trace";

const agentId = "eval-agent";
const now = "2026-08-10T00:00:00.000Z";
const dir = mkdtempSync(join(tmpdir(), "signet-claim-trace-eval-"));
mkdirSync(join(dir, "memory"), { recursive: true });
initDbAccessor(join(dir, "memory", "memories.db"));

interface ScenarioResult {
	readonly name: string;
	readonly passed: boolean;
	readonly unsupportedCertainty: boolean;
	readonly expected: string;
	readonly observed: string;
}

function insertMemory(
	db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
	input: {
		readonly id: string;
		readonly content: string;
		readonly agentId?: string;
		readonly memoryKind: string;
		readonly deleted?: number;
	},
): void {
	db.prepare(
		`INSERT INTO memories
		 (id, content, type, agent_id, updated_by, memory_kind, visibility, scope, is_deleted, created_at, updated_at)
		 VALUES (?, ?, 'fact', ?, 'claim-trace-eval', ?, 'global', NULL, ?, ?, ?)`,
	).run(input.id, input.content, input.agentId ?? agentId, input.memoryKind, input.deleted ?? 0, now, now);
}

function insertClaim(
	db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
	input: {
		readonly id: string;
		readonly memoryId: string;
		readonly claimKey: string;
		readonly content: string;
		readonly status?: string;
		readonly version?: number;
		readonly rootId?: string;
		readonly previousId?: string | null;
		readonly groupKey?: string;
		readonly evidence?: readonly unknown[];
		readonly agentId?: string;
	},
): void {
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance,
		  status, group_key, claim_key, version, version_root_id, previous_attribute_id, proposal_evidence,
		  created_at, updated_at)
		 VALUES (?, 'eval-aspect', ?, ?, 'attribute', ?, ?, 0.9, 0.8, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.agentId ?? agentId,
		input.memoryId,
		input.content,
		input.content.toLowerCase(),
		input.status ?? "active",
		input.groupKey ?? "eval",
		input.claimKey,
		input.version ?? 1,
		input.rootId ?? input.id,
		input.previousId ?? null,
		JSON.stringify(input.evidence ?? []),
		now,
		now,
	);
}

function link(
	db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
	derivedMemoryId: string,
	sourceKind: string,
	sourceId: string,
	linkAgentId = agentId,
): void {
	db.prepare(
		`INSERT INTO derived_memory_sources
		 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
		 VALUES (?, ?, ?, NULL, ?, ?)`,
	).run(derivedMemoryId, sourceKind, sourceId, linkAgentId, now);
}

function explain(
	claim: string,
	options: { readonly sessionKey?: string; readonly premiseLimit?: number } = {},
): ClaimTraceResult {
	return explainOntologyClaim(getDbAccessor(), {
		agentId,
		entity: "Eval Editor",
		aspect: "preferences",
		group: claim === "session_pref" ? "sessions" : "eval",
		claim,
		sessionKey: options.sessionKey,
		premiseLimit: options.premiseLimit,
	});
}

const scenarios: ScenarioResult[] = [];
const started = performance.now();

try {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES ('eval-entity', 'Eval Editor', 'eval editor', 'tool', ?, 1, ?, ?)`,
		).run(agentId, now, now);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES ('eval-aspect', 'eval-entity', ?, 'preferences', 'preferences', 0.8, ?, ?)`,
		).run(agentId, now, now);

		insertMemory(db, {
			id: "eval-source-pref",
			content: "The user prefers the editor to open files in tabs.",
			memoryKind: "episodic",
		});
		insertMemory(db, { id: "eval-derived-old", content: "The editor opens files in tabs.", memoryKind: "derived" });
		insertMemory(db, {
			id: "eval-derived-current",
			content: "The user prefers the editor to open files in tabs.",
			memoryKind: "derived",
		});
		insertMemory(db, {
			id: "eval-dependent",
			content: "The editor tab behavior is a current preference.",
			memoryKind: "derived",
		});
		insertClaim(db, {
			id: "eval-old",
			memoryId: "eval-derived-old",
			claimKey: "editor_pref",
			content: "The editor opens files in tabs.",
			status: "superseded",
			version: 1,
			rootId: "eval-old",
			evidence: [{ source_ref: "memory:eval-source-pref", quote: "open files in tabs" }],
		});
		insertClaim(db, {
			id: "eval-current",
			memoryId: "eval-derived-current",
			claimKey: "editor_pref",
			content: "The user prefers the editor to open files in tabs.",
			version: 2,
			rootId: "eval-old",
			previousId: "eval-old",
			evidence: [{ source_ref: "memory:eval-source-pref", quote: "prefers the editor to open files in tabs" }],
		});
		db.prepare("UPDATE entity_attributes SET superseded_by = 'eval-current' WHERE id = 'eval-old'").run();
		insertClaim(db, {
			id: "eval-dependent-attr",
			memoryId: "eval-dependent",
			claimKey: "dependent_note",
			groupKey: "other",
			content: "The editor tab behavior is a current preference.",
		});
		link(db, "eval-derived-old", "memory", "eval-source-pref");
		link(db, "eval-derived-current", "memory", "eval-source-pref");
		link(db, "eval-dependent", "memory", "eval-derived-current");

		for (const [id, content] of [
			["eval-source-a", "The user prefers tabs in the editor."],
			["eval-source-b", "The user prefers a single editor pane."],
		] as const) {
			insertMemory(db, { id, content, memoryKind: "episodic" });
		}
		for (const [id, memoryId, content, sourceId, quote] of [
			["eval-comp-a", "eval-comp-memory-a", "The editor uses tabs.", "eval-source-a", "prefers tabs"],
			[
				"eval-comp-b",
				"eval-comp-memory-b",
				"The editor uses one pane.",
				"eval-source-b",
				"prefers a single editor pane",
			],
		] as const) {
			insertMemory(db, { id: memoryId, content, memoryKind: "derived" });
			insertClaim(db, {
				id,
				memoryId,
				claimKey: "competing",
				content,
				evidence: [{ source_ref: `memory:${sourceId}`, quote }],
			});
			link(db, memoryId, "memory", sourceId);
		}
		createEpistemicAssertionsInTx(getDbAccessor(), db, [
			{
				agentId,
				entityId: "eval-entity",
				claimAttributeId: "eval-comp-a",
				predicate: "denies",
				content: "The editor does not use tabs.",
				evidence: [{ source_ref: "memory:eval-source-a", quote: "prefers tabs" }],
			},
		]);

		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, harness, project, agent_id, created_at, updated_at, completed_at)
			 VALUES ('eval-session-a', 'The user prefers tabs in the editor.', 'eval', '/eval', ?, ?, ?, ?)`,
		).run(agentId, now, now, now);
		insertMemory(db, { id: "eval-session-derived", content: "Session preference.", memoryKind: "derived" });
		insertClaim(db, {
			id: "eval-session-attr",
			memoryId: "eval-session-derived",
			claimKey: "session_pref",
			groupKey: "sessions",
			content: "The user prefers tabs in the editor.",
			evidence: [{ source_ref: "transcript:eval-session-a", quote: "prefers tabs in the editor" }],
		});
		link(db, "eval-session-derived", "transcript", "eval-session-a");

		insertMemory(db, {
			id: "eval-deleted-source",
			content: "The user preferred a deleted option.",
			memoryKind: "episodic",
			deleted: 1,
		});
		insertMemory(db, { id: "eval-deleted-derived", content: "Deleted claim.", memoryKind: "derived" });
		insertClaim(db, {
			id: "eval-deleted-attr",
			memoryId: "eval-deleted-derived",
			claimKey: "deleted",
			content: "The user preferred a deleted option.",
			evidence: [{ source_ref: "memory:eval-deleted-source", quote: "preferred a deleted option" }],
		});
		link(db, "eval-deleted-derived", "memory", "eval-deleted-source");

		insertMemory(db, {
			id: "eval-foreign-source",
			content: "Other agent evidence.",
			agentId: "other-agent",
			memoryKind: "episodic",
		});
		insertMemory(db, { id: "eval-foreign-derived", content: "Foreign claim.", memoryKind: "derived" });
		insertClaim(db, {
			id: "eval-foreign-attr",
			memoryId: "eval-foreign-derived",
			claimKey: "foreign",
			content: "Foreign claim.",
		});
		link(db, "eval-foreign-derived", "memory", "eval-foreign-source");

		insertMemory(db, { id: "eval-fabricated-derived", content: "Fabricated claim.", memoryKind: "derived" });
		insertClaim(db, {
			id: "eval-fabricated-attr",
			memoryId: "eval-fabricated-derived",
			claimKey: "fabricated",
			content: "Fabricated claim.",
		});
		link(db, "eval-fabricated-derived", "memory", "does-not-exist");
	});

	const run = (name: string, expected: string, fn: () => unknown, check: (value: unknown) => boolean): void => {
		try {
			const value = fn();
			const observed =
				value instanceof Error ? value.message : typeof value === "object" && value !== null ? "trace" : String(value);
			scenarios.push({
				name,
				expected,
				observed,
				passed: check(value),
				unsupportedCertainty: isTrace(value) && value.integrity.status !== "verified",
			});
		} catch (error) {
			const observed = error instanceof OntologyClaimTraceError ? `${error.status}: ${error.message}` : String(error);
			scenarios.push({ name, expected, observed, passed: check(error), unsupportedCertainty: false });
		}
	};

	run(
		"changed preference exposes current and prior versions",
		"active + 2 versions",
		() => explain("editor_pref"),
		(value) => {
			return isTrace(value) && value.current.status === "active" && value.versions.items.length === 2;
		},
	);
	run(
		"competing values remain visible",
		"competing with contradictory assertion",
		() => explain("competing"),
		(value) =>
			isTrace(value) && value.current.status === "competing" && value.competing.contradictoryAssertions.length === 1,
	);
	run(
		"session allowlist accepts matching transcript",
		"verified",
		() => explain("session_pref", { sessionKey: "eval-session-a" }),
		(value) => isTrace(value) && value.integrity.status === "verified",
	);
	run(
		"session allowlist rejects a different session",
		"403",
		() => explain("session_pref", { sessionKey: "eval-session-b" }),
		(value) => value instanceof OntologyClaimTraceError && value.status === 403,
	);
	run(
		"deleted evidence is not current truth",
		"invalidated",
		() => explain("deleted"),
		(value) => isTrace(value) && value.integrity.status === "invalidated",
	);
	run(
		"cross-agent source is forbidden",
		"403",
		() => explain("foreign"),
		(value) => value instanceof OntologyClaimTraceError && value.status === 403,
	);
	run(
		"fabricated source id is rejected",
		"409",
		() => explain("fabricated"),
		(value) => value instanceof OntologyClaimTraceError && value.status === 409,
	);
	run(
		"reverse lineage is bounded",
		"one dependent at depth one",
		() => explain("editor_pref", { premiseLimit: 1 }),
		(value) => isTrace(value) && value.reverse.items.length === 1 && value.traversal.bounded,
	);
} finally {
	const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
	const passed = scenarios.filter((scenario) => scenario.passed).length;
	const unsupportedCertainty = scenarios.filter((scenario) => scenario.unsupportedCertainty).length;
	const report = {
		scenarios: scenarios.length,
		passed,
		accuracy: scenarios.length === 0 ? 0 : Math.round((passed / scenarios.length) * 1000) / 1000,
		unsupportedCertainty,
		latencyMs: elapsedMs,
		toolCalls: scenarios.length,
		results: scenarios,
	};
	console.log(JSON.stringify(report, null, 2));
	closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
	if (passed !== scenarios.length) process.exitCode = 1;
}

function isTrace(value: unknown): value is ClaimTraceResult {
	return typeof value === "object" && value !== null && "integrity" in value && "traversal" in value;
}

process.exit(process.exitCode ?? 0);
