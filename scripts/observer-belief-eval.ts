#!/usr/bin/env bun
/**
 * Deterministic observer-scoped belief evaluation for #1317.
 *
 * Both agents ingest the same raw interleaved conversation. A deterministic
 * provider stand-in extracts the selected speaker's message through the
 * ontology extraction pipeline, and the eval proves that the resulting
 * directional assertions remain observer-scoped and queryable.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../platform/daemon/src/db-accessor";
import { extractOntologyProposals } from "../platform/daemon/src/ontology-extraction";
import { registerOntologyRoutes } from "../platform/daemon/src/routes/ontology-routes";

const NOW = "2026-08-14T00:00:00.000Z";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const ENTITY_NAME = "Shared Person";
const INTERLEAVED_CONVERSATION = [
	"Alice: Shared Person prefers local-first memory.",
	"Bob: Shared Person prefers hosted memory.",
	"Alice: The two observations should remain attributed.",
].join("\n");

type EvalResult = {
	readonly name: string;
	readonly passed: boolean;
};

export type ObserverBeliefEvalResult = {
	readonly eval: "observer-belief";
	readonly passed: number;
	readonly total: number;
	readonly results: readonly EvalResult[];
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

type Speaker = "Alice" | "Bob";

function seedSubject(id: string, agentId: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities
			 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, 'person', ?, 1, ?, ?)`,
		).run(id, ENTITY_NAME, ENTITY_NAME.toLowerCase(), agentId, NOW, NOW);
	});
}

function seedInterleavedTranscript(agentId: string, sessionKey: string): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, content, harness, project, agent_id, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'eval', '/observer-eval', ?, ?, ?, ?)`,
		).run(sessionKey, INTERLEAVED_CONVERSATION, agentId, NOW, NOW, NOW);
	});
}

function messageForSpeaker(conversation: string, speaker: Speaker): string {
	const line = conversation.split("\n").find((candidate) => candidate.startsWith(`${speaker}:`));
	if (!line) throw new Error(`No message found for ${speaker}`);
	return line.slice(speaker.length + 1).trim();
}

function providerForSpeaker(speaker: Speaker): LlmProvider {
	return {
		name: `observer-belief-eval-${speaker.toLowerCase()}`,
		available: async (): Promise<boolean> => true,
		generate: async (prompt: string): Promise<string> => {
			const marker = "Source content:\n";
			const sourceContent = prompt.slice(prompt.lastIndexOf(marker) + marker.length);
			const content = messageForSpeaker(sourceContent, speaker);
			return `Derived assertions:\n${JSON.stringify({
				assertions: [
					{
						entity: ENTITY_NAME,
						predicate: "believes",
						content,
						speaker,
						evidence: [{ quote: content }],
					},
				],
			})}`;
		},
	};
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

export async function runObserverBeliefEval(): Promise<ObserverBeliefEvalResult> {
	const dir = mkdtempSync(join(tmpdir(), "signet-observer-belief-eval-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
	const results: EvalResult[] = [];
	try {
		seedSubject("subject-a", AGENT_A);
		seedSubject("subject-b", AGENT_B);
		seedInterleavedTranscript(AGENT_A, "conversation-a");
		seedInterleavedTranscript(AGENT_B, "conversation-b");

		const extractedA = await extractOntologyProposals(getDbAccessor(), {
			agentId: AGENT_A,
			from: "conversation-a",
			writeAssertions: true,
			createdBy: "observer-belief-eval",
			useProvider: true,
			provider: providerForSpeaker("Alice"),
		});
		const extractedB = await extractOntologyProposals(getDbAccessor(), {
			agentId: AGENT_B,
			from: "conversation-b",
			writeAssertions: true,
			createdBy: "observer-belief-eval",
			useProvider: true,
			provider: providerForSpeaker("Bob"),
		});
		const contentA = messageForSpeaker(INTERLEAVED_CONVERSATION, "Alice");
		const contentB = messageForSpeaker(INTERLEAVED_CONVERSATION, "Bob");
		results.push({
			name: "raw interleaved messages produce one provider-derived assertion per observer",
			passed:
				extractedA.providerName === "observer-belief-eval-alice" &&
				extractedB.providerName === "observer-belief-eval-bob" &&
				extractedA.writtenAssertionCount === 1 &&
				extractedB.writtenAssertionCount === 1 &&
				extractedA.assertionItems[0]?.content === contentA &&
				extractedB.assertionItems[0]?.content === contentB &&
				extractedA.assertionItems[0]?.subjectEntityName === ENTITY_NAME &&
				extractedB.assertionItems[0]?.subjectEntityName === ENTITY_NAME,
		});

		const app = new Hono();
		registerOntologyRoutes(app);
		const agentA = await queryAssertions(app, AGENT_A);
		const agentB = await queryAssertions(app, AGENT_B);
		results.push({
			name: "observer-scoped HTTP queries preserve separate directional observations",
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
		return { eval: "observer-belief", passed, total: results.length, results };
	} finally {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	void runObserverBeliefEval()
		.then((result) => {
			console.log(JSON.stringify(result, null, 2));
			process.exit(result.passed === result.total ? 0 : 1);
		})
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		});
}
