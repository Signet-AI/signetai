import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DreamingConfig } from "@signet/core";
import { MIGRATIONS } from "../../../core/src/migrations";
import { type DbAccessor, prepareTypedStatement, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { searchEpisodicSources } from "../episodic-sources";
import { writeSessionTranscriptRow } from "../session-transcripts";
import { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } from "../transcript-capture-worker";
import { getDreamingToolCalls, runDreamingAgentPass } from "./dreaming";
import { DEFAULT_DREAMING_POLICIES } from "./dreaming-policies";

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
		enabled: true,
		tokenThreshold: 1,
		maxInterval: 6 * 60 * 60 * 1_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: true,
		policies: DEFAULT_DREAMING_POLICIES,
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
		} catch {}
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
		for (const migration of MIGRATIONS) migration.up(db);
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
		const passes: Array<{ agentId: string; passId: string; applied: number; failed: number }> = [];
		for (const agentId of agentIds) {
			const result = await runDreamingAgentPass(
				accessor,
				{
					async run(input) {
						const search = input.tools.find((tool) => tool.name === "search_evidence");
						const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
						if (!search || !apply) throw new Error("MemoryBench gate requires canonical Dreaming tools");

						await search.execute("search", { agentId });
						for (const scenario of corpus.scenarios.filter((scenario) => scenario.agentId === agentId)) {
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
								await apply.execute("apply", { agentId: scenario.agentId, operations }),
							);
							if (!toolResult.ok)
								throw new Error(`Canonical apply failed for ${scenario.id}: ${JSON.stringify(toolResult)}`);
						}
						return { summary: "Applied committed MemoryBench fixture semantics" };
					},
				},
				defaultCfg(),
				"/tmp",
				agentId,
				[agentId],
				"incremental",
			);

			passes.push({ agentId, ...result });
		}
		expect(passes.reduce((sum, pass) => sum + pass.applied, 0)).toBe(corpus.scenarios.length);
		expect(passes.every((pass) => pass.failed === 0)).toBe(true);
		const calls = (
			await Promise.all(passes.map((pass) => getDreamingToolCalls(accessor, pass.agentId, pass.passId)))
		).flat();
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

	it("files unnamed shared-agent speakers on distinct authenticated people in the deterministic fixture", async () => {
		const corpus = z
			.object({
				agentId: z.string(),
				users: z.array(
					z.object({
						id: z.string(),
						username: z.string(),
						displayName: z.string(),
						sessionId: z.string(),
						quote: z.string(),
						claimKey: z.string(),
						value: z.string(),
					}),
				),
			})
			.parse(
				JSON.parse(
					readFileSync(new URL("../../../../memorybench/config/dreaming-gate/speakers.json", import.meta.url), "utf8"),
				),
			);
		db.prepare("UPDATE organization SET claimed_at='2026-01-01', agent_model='single'").run();
		db.prepare("INSERT INTO groups(id,name) VALUES('dreaming-gate-speakers','Dreaming gate speakers')").run();
		db.prepare(
			"INSERT INTO agents(id,name,kind,owner_group_id,created_at,updated_at) VALUES(?,?,'team','dreaming-gate-speakers','2026-01-01','2026-01-01')",
		).run(corpus.agentId, "Shared speaker fixture");
		for (const user of corpus.users) {
			expect(user.quote).not.toContain(user.displayName);
			expect(user.quote).not.toContain(user.username);
			db.prepare("INSERT INTO users (id,username,display_name,role) VALUES (?,?,?,'member')").run(
				user.id,
				user.username,
				user.displayName,
			);
			db.prepare("INSERT INTO group_members(group_id,user_id,role) VALUES('dreaming-gate-speakers',?,'member')").run(
				user.id,
			);
			expect(
				db
					.query(
						"SELECT name,compartment_id,proposal_evidence,dreaming_pass_id FROM entities WHERE agent_id=? AND person_user_id=?",
					)
					.get(corpus.agentId, user.id),
			).toEqual({
				name: `${user.displayName} (${user.username})`,
				compartment_id: null,
				proposal_evidence: "[]",
				dreaming_pass_id: null,
			});
			expect(
				writeSessionTranscriptRow(db, {
					agentId: corpus.agentId,
					sessionKey: user.sessionId,
					transcript: `User: ${user.quote}`,
					harness: "codex",
					project: null,
					author: { userId: user.id, credential: `key:${user.username}` },
					completedAt: "2026-01-01T00:00:00.000Z",
				}),
			).toBe("written");
		}
		const deliveredSchema = z.object({
			ok: z.literal(true),
			items: z.array(
				z.object({
					sourceRef: z.string(),
					content: z.string(),
					speaker: z.object({
						kind: z.literal("person"),
						userId: z.string(),
						personEntityId: z.string(),
						personEntityName: z.string(),
					}),
				}),
			),
		});
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const search = input.tools.find((tool) => tool.name === "search_evidence");
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!search || !apply) throw new Error("Canonical Dreaming tools required");
					const delivered = deliveredSchema.parse(
						readToolResult(await search.execute("search", { agentId: corpus.agentId })),
					);
					expect(delivered.items).toHaveLength(corpus.users.length);
					for (const item of delivered.items) {
						const user = corpus.users.find((user) => item.content.includes(user.quote));
						if (!user) throw new Error("Unexpected fixture source");
						expect(item.speaker.userId).toBe(user.id);
						const evidence = [{ source_ref: item.sourceRef, quote: user.quote }];
						const aspect = z
							.object({ ok: z.literal(true), items: z.array(z.object({ result: z.object({ aspectId: z.string() }) })) })
							.parse(
								readToolResult(
									await apply.execute("aspect", {
										agentId: corpus.agentId,
										operations: [
											{
												operation: "create_aspect",
												payload: { entityId: item.speaker.personEntityId, name: "preferences" },
												evidence,
												reason: "The speaker disclosed a preference.",
											},
										],
									}),
								),
							);
						const aspectId = aspect.items[0]?.result.aspectId;
						if (!aspectId) throw new Error("Canonical aspect creation did not return an aspect id");
						expect(
							readToolResult(
								await apply.execute("claim", {
									agentId: corpus.agentId,
									operations: [
										{
											operation: "add_claim_value",
											payload: {
												entityId: item.speaker.personEntityId,
												aspectId,
												claimKey: user.claimKey,
												value: user.value,
											},
											evidence,
											reason: "The authenticated speaker disclosed this preference.",
										},
									],
								}),
							),
						).toMatchObject({ ok: true });
					}
					return { summary: "Filed each authenticated speaker's disclosed preference." };
				},
			},
			defaultCfg(),
			"/tmp",
			corpus.agentId,
			[corpus.agentId],
			"incremental",
		);
		expect(result).toMatchObject({ failed: 0 });
		const people = prepareTypedStatement<{
			person_user_id: string;
			name: string;
			content: string;
			proposal_evidence: string;
		}>(
			db,
			`SELECT e.person_user_id, e.name, a.content, a.proposal_evidence FROM entities e
			JOIN entity_aspects aspect ON aspect.entity_id=e.id JOIN entity_attributes a ON a.aspect_id=aspect.id WHERE e.agent_id=? ORDER BY e.person_user_id`,
		).all(corpus.agentId);
		expect(people).toHaveLength(2);
		for (const user of corpus.users) {
			expect(people.find((person) => person.person_user_id === user.id)).toMatchObject({
				name: `${user.displayName} (${user.username})`,
				content: user.value,
				proposal_evidence: expect.stringContaining(`transcript:${user.sessionId}`),
			});
		}
		expect(new Set(people.map((person) => person.name)).size).toBe(2);
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
					await enqueueTranscriptCaptureJob(getDbAccessor(), {
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
							limit: 10,
						}),
					);
					const matches = sources.filter((candidate) => candidate.sourceId === sourceSessionId);
					expect(matches).toHaveLength(1);
					expect(matches[0]).toMatchObject({
						kind: "transcript",
						sourceId: sourceSessionId,
						content: expect.stringContaining(quote),
						completed: true,
					});
				}
			}
		} finally {
			await closeDbAccessor();
			if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
			else process.env.SIGNET_PATH = previousSignetPath;
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
