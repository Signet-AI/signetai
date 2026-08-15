#!/usr/bin/env bun
/**
 * Deterministic observer-scoped belief evaluation for #1317.
 *
 * Each agent ingests the same interleaved conversation with a different
 * directional assertion about the same named entity. The eval proves that
 * extraction preserves both observations and that the observer-scoped HTTP
 * query returns each agent's assertion separately.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../platform/daemon/src/db-accessor";
import { extractOntologyProposals } from "../platform/daemon/src/ontology-extraction";
import { registerOntologyRoutes } from "../platform/daemon/src/routes/ontology-routes";

const NOW = "2026-08-14T00:00:00.000Z";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const ENTITY_NAME = "Shared Person";

type EvalResult = {
	readonly name: string;
	readonly passed: boolean;
};

type AssertionApiItem = {
	readonly id: string;
	readonly observerId: string;
	readonly subjectEntityName: string | null;
	readonly content: string;
	readonly sourceId: string | null;
};

type AssertionApiResponse = {
	readonly items: readonly AssertionApiItem[];
	readonly count: number;
};

function seedSubject(id: string, agentId: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, 'person', ?, 1, ?, ?)`,
		).run(id, ENTITY_NAME, ENTITY_NAME.toLowerCase(), agentId, NOW, NOW);
	});
}

function seedInterleavedTranscript(agentId: string, sessionKey: string, content: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, harness, project, agent_id, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'eval', '/observer-eval', ?, ?, ?, ?)`,
		).run(sessionKey, content, agentId, NOW, NOW, NOW);
	});
}

function conversationFor(content: string, speaker: string, sourceId: string): string {
	return JSON.stringify({
		messages: [
			{ speaker: "Alice", text: "Shared Person prefers local-first memory." },
			{ speaker: "Bob", text: "Shared Person prefers hosted memory." },
			{ speaker: "Alice", text: "The two observations should remain attributed." },
		],
		assertions: [
			{
				entity: ENTITY_NAME,
				predicate: "believes",
				content,
				speaker,
				evidence: [{ source_kind: "transcript", source_id: sourceId, quote: content }],
			},
		],
	});
}

async function queryAssertions(app: Hono, agentId: string): Promise<AssertionApiResponse | null> {
	const query = new URLSearchParams({
		agent_id: agentId,
		observer_id: agentId,
		entity: ENTITY_NAME,
	});
	const response = await app.request(`/api/ontology/assertions?${query.toString()}`);
	if (response.status !== 200) return null;
	return (await response.json()) as AssertionApiResponse;
}

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "signet-observer-belief-eval-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
	const results: EvalResult[] = [];
	let exitCode = 0;
	try {
		seedSubject("subject-a", AGENT_A);
		seedSubject("subject-b", AGENT_B);

		const contentA = "Shared Person prefers local-first memory.";
		const contentB = "Shared Person prefers hosted memory.";
		seedInterleavedTranscript(AGENT_A, "conversation-a", conversationFor(contentA, "Alice", "conversation-a"));
		seedInterleavedTranscript(AGENT_B, "conversation-b", conversationFor(contentB, "Bob", "conversation-b"));

		const extractedA = await extractOntologyProposals(getDbAccessor(), {
			agentId: AGENT_A,
			from: "conversation-a",
			writeAssertions: true,
			createdBy: "observer-belief-eval",
		});
		const extractedB = await extractOntologyProposals(getDbAccessor(), {
			agentId: AGENT_B,
			from: "conversation-b",
			writeAssertions: true,
			createdBy: "observer-belief-eval",
		});
		results.push({
			name: "interleaved conversation extraction writes one assertion per agent",
			passed:
				extractedA.writtenAssertionCount === 1 &&
				extractedB.writtenAssertionCount === 1 &&
				extractedA.assertionItems[0]?.subjectEntityName === ENTITY_NAME &&
				extractedB.assertionItems[0]?.subjectEntityName === ENTITY_NAME,
		});

		const app = new Hono();
		registerOntologyRoutes(app);
		const agentA = await queryAssertions(app, AGENT_A);
		const agentB = await queryAssertions(app, AGENT_B);
		results.push({
			name: "observer-scoped HTTP queries return separate directional observations",
			passed:
				agentA?.items.length === 1 &&
				agentB?.items.length === 1 &&
				agentA.items[0]?.observerId === AGENT_A &&
				agentB.items[0]?.observerId === AGENT_B &&
				agentA.items[0]?.subjectEntityName === ENTITY_NAME &&
				agentB.items[0]?.subjectEntityName === ENTITY_NAME &&
				agentA.items[0]?.content === contentA &&
				agentB.items[0]?.content === contentB &&
				agentA.items[0]?.content !== agentB.items[0]?.content &&
				agentA.items[0]?.id !== agentB.items[0]?.id &&
				agentA.items[0]?.sourceId === "conversation-a" &&
				agentB.items[0]?.sourceId === "conversation-b",
		});

		const peerQuery = new URLSearchParams({
			agent_id: AGENT_A,
			observer_id: AGENT_B,
			entity: ENTITY_NAME,
		});
		const peerResponse = await app.request(`/api/ontology/assertions?${peerQuery.toString()}`);
		results.push({
			name: "observer scope rejects a peer observer",
			passed: peerResponse.status === 403,
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

void main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
