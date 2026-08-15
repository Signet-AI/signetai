import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import { type DbAccessor, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { searchEpisodicSources } from "../episodic-sources";
import { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } from "../transcript-capture-worker";
import { getDreamingToolCalls, runDreamingAgentPass } from "./dreaming";

interface GateSession {
	readonly id: string;
	readonly agentId?: string;
	readonly messages: ReadonlyArray<{ readonly content: string }>;
}

interface GateScenario {
	readonly id: string;
	readonly agentId: string;
	readonly sessions: ReadonlyArray<GateSession>;
	readonly expected: {
		readonly sourceQuotes: readonly string[];
		readonly sourceSessionIds: readonly string[];
		readonly semanticOutcome: {
			readonly entity: string;
			readonly aspect: string;
			readonly claimKey: string;
			readonly value: string;
		};
	};
}

interface GateCorpus {
	readonly scenarios: readonly GateScenario[];
}

function readCorpus(): GateCorpus {
	const url = new URL("../../../../memorybench/config/dreaming-gate/scenarios.json", import.meta.url);
	return JSON.parse(readFileSync(url, "utf8")) as GateCorpus;
}

function defaultCfg(): DreamingConfig {
	return {
		tokenThreshold: 1,
		maxInterval: 6 * 60 * 60 * 1_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: true,
	};
}

function wrapDb(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (database: Database) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (database: Database) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		async withReadDbAsync<T>(fn: (database: Database) => Promise<T>): Promise<T> {
			return fn(db);
		},
		async withWriteTxAsync<T>(fn: (database: Database) => T): Promise<T> {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = await fn(db);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as DbAccessor;
}

function readToolResult(result: { readonly content: ReadonlyArray<unknown> }): {
	readonly ok: boolean;
	readonly [key: string]: unknown;
} {
	const first = result.content[0] as { readonly text?: string } | undefined;
	const text = first && typeof first.text === "string" ? first.text : "";
	return JSON.parse(text) as { readonly ok: boolean; readonly [key: string]: unknown };
}

function fixtureEntityId(scenario: GateScenario): string {
	return `memorybench-${scenario.id}-entity`;
}

function fixtureAspectId(scenario: GateScenario): string {
	return `memorybench-${scenario.id}-aspect`;
}

function seedSemanticTarget(db: Database, scenario: GateScenario): void {
	const outcome = scenario.expected.semanticOutcome;
	const entityId = fixtureEntityId(scenario);
	const aspectId = fixtureAspectId(scenario);
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
		 VALUES (?, ?, ?, 'project', ?, 0, 0, datetime('now'), datetime('now'))`,
	).run(entityId, outcome.entity, outcome.entity.toLowerCase(), scenario.agentId);
	db.prepare(
		`INSERT INTO entity_aspects
		 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
	).run(aspectId, entityId, scenario.agentId, outcome.aspect, outcome.aspect.toLowerCase());
}

function seedSession(db: Database, session: GateSession, agentId: string): void {
	const content = session.messages.map((message) => message.content).join("\n");
	db.prepare(
		`INSERT INTO session_transcripts
		 (session_key, content, agent_id, created_at, updated_at, completed_at)
		 VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
	).run(session.id, content, agentId);
	db.prepare(
		`INSERT INTO session_summaries
		 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
		 VALUES (?, ?, ?, ?, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
	).run(session.id, agentId, content, Math.max(1, content.length));
}

function readWorkflowTriggerPaths(trigger: "pull_request" | "push"): readonly string[] {
	const workflow = readFileSync(
		new URL("../../../../.github/workflows/memorybench-dreaming-gate.yml", import.meta.url),
		"utf8",
	);
	const paths: string[] = [];
	let collecting = false;
	for (const line of workflow.split("\n")) {
		if (line === `  ${trigger}:`) {
			collecting = true;
			continue;
		}
		if (collecting && /^ {2}\S/.test(line)) break;
		if (!collecting) continue;
		const match = line.match(/^\s+- "([^"]+)"$/);
		if (match?.[1]) paths.push(match[1]);
	}
	return paths;
}

const LOCAL_IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|export\s+from\s*)["']([^"']+)["']/g;

function resolveLocalImport(source: URL, specifier: string): URL | null {
	if (!specifier.startsWith(".")) return null;
	const candidates = [
		new URL(`${specifier}.ts`, source),
		new URL(`${specifier}.tsx`, source),
		new URL(`${specifier}/index.ts`, source),
		new URL(specifier, source),
	];
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// The import may target a package or a non-TypeScript asset.
		}
	}
	return null;
}

function readGateDependencyPaths(): readonly string[] {
	const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
	const pending = [new URL(import.meta.url)];
	const seen = new Set<string>();
	while (pending.length > 0) {
		const source = pending.pop();
		if (!source) continue;
		const sourcePath = fileURLToPath(source);
		if (seen.has(sourcePath)) continue;
		seen.add(sourcePath);
		const text = readFileSync(source, "utf8");
		for (const match of text.matchAll(LOCAL_IMPORT_PATTERN)) {
			const specifier = match[1];
			if (!specifier) continue;
			const dependency = resolveLocalImport(source, specifier);
			if (dependency) pending.push(dependency);
		}
	}
	return [...seen].map((path) => relative(repoRoot, path).replaceAll("\\", "/")).sort();
}

function workflowPathPatternMatches(path: string, pattern: string): boolean {
	let expression = "^";
	for (let index = 0; index < pattern.length; ) {
		if (pattern.startsWith("**", index)) {
			expression += ".*";
			index += 2;
			continue;
		}
		const character = pattern[index];
		if (character === "*") {
			expression += "[^/]*";
			index += 1;
			continue;
		}
		if ("\\^$+?.()|[]{}".includes(character)) expression += `\\${character}`;
		else expression += character;
		index += 1;
	}
	return new RegExp(`${expression}$`).test(path);
}

describe("MemoryBench Dreaming gate", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => {
		db.close();
	});

	it("triggers for every transitive gate dependency on pull requests and main pushes", () => {
		const requiredContractPaths = [
			".github/workflows/memorybench-dreaming-gate.yml",
			"platform/daemon/src/**",
			"platform/core/src/**",
		];
		const newlyCoveredDependencies = [
			"platform/daemon/src/yielding-writes.ts",
			"platform/daemon/src/derived-memory-provenance.ts",
			"platform/daemon/src/knowledge-graph-hygiene.ts",
			"platform/daemon/src/pipeline/tokenizer.ts",
			"platform/daemon/src/ontology-contradictions.ts",
			"platform/daemon/src/ontology-evidence.ts",
			"platform/daemon/src/transactions.ts",
		];
		const gateDependencies = readGateDependencyPaths();
		for (const trigger of ["pull_request", "push"] as const) {
			const triggerPaths = readWorkflowTriggerPaths(trigger);
			expect(triggerPaths).toEqual(expect.arrayContaining(requiredContractPaths));
			for (const dependency of newlyCoveredDependencies) {
				expect(triggerPaths.some((pattern) => workflowPathPatternMatches(dependency, pattern))).toBe(true);
			}
			for (const dependency of gateDependencies) {
				if (!dependency.startsWith("platform/daemon/src/") && !dependency.startsWith("platform/core/src/")) continue;
				expect(triggerPaths.some((pattern) => workflowPathPatternMatches(dependency, pattern))).toBe(true);
			}
		}
	});

	it("derives each committed semantic outcome from the declared transcript sources", async () => {
		const corpus = readCorpus();
		for (const scenario of corpus.scenarios) {
			seedSemanticTarget(db, scenario);
			for (const session of scenario.sessions) seedSession(db, session, session.agentId ?? scenario.agentId);
		}

		const agentIds = [
			...new Set(
				corpus.scenarios.flatMap((scenario) => scenario.sessions.map((session) => session.agentId ?? scenario.agentId)),
			),
		];
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!search || !apply) throw new Error("MemoryBench gate requires canonical Dreaming tools");

					for (const agentId of agentIds) {
						await search.execute("search", { agentId }, undefined, undefined, {} as never);
					}
					for (const scenario of corpus.scenarios) {
						const outcome = scenario.expected.semanticOutcome;
						const operations = scenario.expected.sourceQuotes.map((quote, index) => ({
							operation: "add_claim_value",
							payload: {
								entityId: fixtureEntityId(scenario),
								aspectId: fixtureAspectId(scenario),
								claimKey: outcome.claimKey,
								value: outcome.value,
							},
							reason: "Committed MemoryBench fixture evidence supports this semantic outcome.",
							evidence: [
								{
									source_ref: `transcript:${scenario.expected.sourceSessionIds[index]}`,
									source_kind: "transcript",
									source_id: scenario.expected.sourceSessionIds[index],
									quote,
								},
							],
						}));
						const toolResult = readToolResult(
							await apply.execute(
								"apply",
								{ agentId: scenario.agentId, operations },
								undefined,
								undefined,
								{} as never,
							),
						);
						if (!toolResult.ok)
							throw new Error(`Canonical apply failed for ${scenario.id}: ${JSON.stringify(toolResult)}`);
					}
					return { summary: "Applied committed MemoryBench fixture semantics" };
				},
			},
			defaultCfg(),
			"/tmp",
			"memorybench",
			agentIds,
			"incremental",
		);

		expect(result).toMatchObject({ applied: corpus.scenarios.length, failed: 0 });
		const calls = await getDreamingToolCalls(accessor, "memorybench", result.passId);
		for (const scenario of corpus.scenarios) {
			for (const sourceSessionId of scenario.expected.sourceSessionIds) {
				expect(
					calls.some(
						(call) =>
							call.toolName === "search_evidence" &&
							JSON.stringify(call.output).includes(`transcript:${sourceSessionId}`),
					),
				).toBe(true);
				expect(
					calls.some(
						(call) =>
							call.toolName === "apply_ontology_ops" &&
							JSON.stringify(call.input).includes(`transcript:${sourceSessionId}`),
					),
				).toBe(true);
			}
			const outcome = scenario.expected.semanticOutcome;
			expect(
				db
					.prepare(
						`SELECT attr.content, attr.proposal_evidence
						 FROM entity_attributes attr
						 JOIN entity_aspects aspect ON aspect.id = attr.aspect_id
						 JOIN entities entity ON entity.id = aspect.entity_id
						 WHERE entity.agent_id = ? AND entity.name = ? AND aspect.name = ? AND attr.claim_key = ?`,
					)
					.get(scenario.agentId, outcome.entity, outcome.aspect, outcome.claimKey),
			).toMatchObject({ content: outcome.value, proposal_evidence: expect.stringContaining("transcript:") });
		}
	});

	it("indexes committed fixture sources through the transcript-capture boundary in their declared scopes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-memorybench-dreaming-gate-"));
		const previousSignetPath = process.env.SIGNET_PATH;
		try {
			process.env.SIGNET_PATH = dir;
			initDbAccessor(join(dir, "memory", "memories.db"));
			const corpus = readCorpus();
			const capturedSessions = corpus.scenarios.flatMap((scenario) =>
				scenario.sessions.map((session) => ({ scenario, session, agentId: session.agentId ?? scenario.agentId })),
			);
			for (const { scenario, session, agentId } of capturedSessions) {
				const transcript = session.messages.map((message) => message.content).join("\n");
				expect(
					enqueueTranscriptCaptureJob(getDbAccessor(), {
						agentId,
						harness: "memorybench",
						sessionKey: session.id,
						sessionId: session.id,
						project: `memorybench:${scenario.id}`,
						transcript,
						rawTranscript: transcript,
						capturedAt: "2026-01-01T00:00:00.000Z",
						endedAt: "2026-01-01T00:00:00.000Z",
					}),
				).toBeTruthy();
			}

			let completed = 0;
			while (await runTranscriptCaptureOnce(getDbAccessor(), dir)) completed++;
			expect(completed).toBe(capturedSessions.length);

			for (const scenario of corpus.scenarios) {
				for (const [index, quote] of scenario.expected.sourceQuotes.entries()) {
					const sourceSessionId = scenario.expected.sourceSessionIds[index];
					const session = scenario.sessions.find((candidate) => candidate.id === sourceSessionId);
					if (!session) throw new Error(`Missing declared source session ${sourceSessionId}`);
					const sources = getDbAccessor().withReadDb((database) =>
						searchEpisodicSources(database, {
							agentId: session.agentId ?? scenario.agentId,
							query: quote,
							kind: "artifact",
							limit: 10,
						}),
					);
					const source = sources.find((candidate) => candidate.sourceId === sourceSessionId);
					expect(source).toMatchObject({
						kind: "artifact",
						sourceId: sourceSessionId,
						content: expect.stringContaining(quote),
						completed: true,
					});
				}
			}
		} finally {
			closeDbAccessor();
			if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
			else process.env.SIGNET_PATH = previousSignetPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
