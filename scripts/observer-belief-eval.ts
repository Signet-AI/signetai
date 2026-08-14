#!/usr/bin/env bun
/**
 * Deterministic observer-scoped belief evaluation for #1317.
 *
 * The two agents receive the same subject name but have separate agent scopes.
 * The eval proves that their assertions diverge, remain queryable by observer,
 * and reject peer-observer and cross-scope semantic-premise fabrication.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../platform/daemon/src/db-accessor";
import {
	OntologyAssertionError,
	createEpistemicAssertion,
	listEpistemicAssertions,
} from "../platform/daemon/src/ontology-assertions";

const NOW = "2026-08-14T00:00:00.000Z";

type EvalResult = {
	readonly name: string;
	readonly passed: boolean;
};

function seedSubject(id: string, name: string, agentId: string, attributeId: string, content: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, 'person', ?, 1, ?, ?)`,
		).run(id, name, name.toLowerCase(), agentId, NOW, NOW);
		db.prepare(
			`INSERT INTO entity_aspects
			 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
			 VALUES (?, ?, ?, 'beliefs', 'beliefs', 0.7, ?, ?)`,
		).run(`${id}-aspect`, id, agentId, NOW, NOW);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
			  status, group_key, claim_key, created_at, updated_at)
			 VALUES (?, ?, ?, 'attribute', ?, ?, 0.9, 0.8, 'active', 'ontology', 'belief', ?, ?)`,
		).run(attributeId, `${id}-aspect`, agentId, content, content.toLowerCase(), NOW, NOW);
	});
}

function expectRejected(action: () => unknown): boolean {
	try {
		action();
		return false;
	} catch (err) {
		return err instanceof OntologyAssertionError;
	}
}

function main(): void {
	const dir = mkdtempSync(join(tmpdir(), "signet-observer-belief-eval-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
	const results: EvalResult[] = [];
	let exitCode = 0;
	try {
		seedSubject("subject-a", "Shared Person", "agent-a", "attribute-a", "Shared Person prefers local-first memory.");
		seedSubject("subject-b", "Shared Person", "agent-b", "attribute-b", "Shared Person prefers hosted memory.");

		const local = createEpistemicAssertion(getDbAccessor(), {
			agentId: "agent-a",
			observerId: "agent-a",
			entity: "Shared Person",
			predicate: "believes",
			content: "Shared Person prefers local-first memory.",
			speaker: "Alice",
			evidence: [{ source_kind: "transcript", quote: "Alice: local-first" }],
			sourceKind: "transcript",
			sourceId: "conversation-a",
		});
		const hosted = createEpistemicAssertion(getDbAccessor(), {
			agentId: "agent-b",
			observerId: "agent-b",
			entity: "Shared Person",
			predicate: "believes",
			content: "Shared Person prefers hosted memory.",
			speaker: "Bob",
			evidence: [{ source_kind: "transcript", quote: "Bob: hosted" }],
			sourceKind: "transcript",
			sourceId: "conversation-b",
		});

		const agentA = listEpistemicAssertions(getDbAccessor(), {
			agentId: "agent-a",
			observerId: "agent-a",
			entity: "Shared Person",
		});
		const agentB = listEpistemicAssertions(getDbAccessor(), {
			agentId: "agent-b",
			observerId: "agent-b",
			entity: "Shared Person",
		});
		results.push({
			name: "directional assertions diverge and remain queryable",
			passed:
				agentA.items.length === 1 &&
				agentB.items.length === 1 &&
				agentA.items[0]?.id === local.id &&
				agentB.items[0]?.id === hosted.id &&
				agentA.items[0]?.content !== agentB.items[0]?.content,
		});
		results.push({
			name: "non-observer query remains backward compatible",
			passed: listEpistemicAssertions(getDbAccessor(), { agentId: "agent-a" }).items[0]?.observerId === "agent-a",
		});
		results.push({
			name: "peer observer read is rejected",
			passed: expectRejected(() =>
				listEpistemicAssertions(getDbAccessor(), { agentId: "agent-a", observerId: "agent-b" }),
			),
		});
		results.push({
			name: "peer observer write is rejected",
			passed: expectRejected(() =>
				createEpistemicAssertion(getDbAccessor(), {
					agentId: "agent-a",
					observerId: "agent-b",
					entity: "Shared Person",
					predicate: "believes",
					content: "Fabricated peer observer belief.",
					evidence: [{ quote: "fabricated" }],
				}),
			),
		});
		results.push({
			name: "cross-scope semantic premise is rejected",
			passed: expectRejected(() =>
				createEpistemicAssertion(getDbAccessor(), {
					agentId: "agent-a",
					observerId: "agent-a",
					entity: "Shared Person",
					predicate: "claims",
					content: "Fabricated from agent B evidence.",
					evidence: [{ quote: "fabricated premise" }],
					sourceKind: "ontology_claim",
					sourceId: "attribute-b",
				}),
			),
		});

		const passed = results.filter((result) => result.passed).length;
		console.log(JSON.stringify({ eval: "observer-belief", passed, total: results.length, results }, null, 2));
		if (passed !== results.length) exitCode = 1;
	} finally {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	}
	process.exit(exitCode);
}

main();
