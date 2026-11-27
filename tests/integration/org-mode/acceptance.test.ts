import "../../support/connector-safety.js";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToken } from "../../../platform/daemon/src/auth/tokens";
import { connectorSecrets } from "./connectors";
import { packageRegistry } from "./package-registry";
import { OrgDaemon } from "./daemon";
import { connector, Fixture } from "./fixture";
import { deriveClaim } from "./graph";
import { record, request, success, until } from "./http";
import { assertUnchanged, checkNoninterference, normalize } from "./noninterference";

async function withFixture(
	run: (fixture: Fixture) => Promise<void>,
	model: "personal" | "single" = "personal",
	seedEvidence = true,
) {
	const daemon = await OrgDaemon.create();
	try {
		await run(await Fixture.create(daemon, model, seedEvidence));
	} finally {
		await daemon.dispose();
	}
}
async function binding(fixture: Fixture): Promise<void> {
	const alice = fixture.user("alice");
	const bob = fixture.user("bob");
	const before = normalize(
		(await request(fixture.daemon.origin, "/api/memories?agent_id=default", alice.session)).body,
	);
	const attempts: { body: { agentId: string }; headers: Record<string, string>; reason: string }[] = [
		{ body: { agentId: bob.agentId }, headers: {}, reason: "agent_binding_conflict" },
		{ body: { agentId: alice.agentId }, headers: { "x-signet-actor": bob.id }, reason: "actor_conflict" },
		{ body: { agentId: alice.agentId }, headers: { "x-signet-actor-type": "another-user" }, reason: "actor_conflict" },
	];
	for (const attempt of attempts) {
		if (fixture.model === "single" && attempt.reason === "agent_binding_conflict") continue;
		const result = await request(
			fixture.daemon.origin,
			"/api/memory/remember",
			alice.connector,
			"POST",
			{ content: "forbidden-impersonation-quokka", project: "atlas", ...attempt.body },
			attempt.headers,
		);
		assert.equal(result.status, 403, "AC1 POST /api/memory/remember must reject credential binding conflicts");
		assert.equal(record(result.body).reason, attempt.reason);
	}
	const deniedAgent = await request(
		fixture.daemon.origin,
		"/api/memory/remember",
		fixture.user("carol").session,
		"POST",
		{ agentId: fixture.engAgent, content: "forbidden-team-agent-quokka" },
	);
	assert.equal(deniedAgent.status, 403, "AC1 member outside eng must not act as eng-agent");
	assert.equal(record(deniedAgent.body).reason, "agent_not_permitted");
	assertUnchanged(
		before,
		normalize((await request(fixture.daemon.origin, "/api/memories?agent_id=default", alice.session)).body),
		"AC1 denied writes leave no evidence",
	);
}
async function deactivate(fixture: Fixture): Promise<void> {
	const bob = fixture.user("bob");
	const second = await connector(fixture.daemon, bob.session, bob.deviceId, bob.agentId, "claude-code");
	const credentials = [bob.session, bob.browser, bob.connector, second.credential];
	for (const credential of credentials)
		assert.equal(
			(await request(fixture.daemon.origin, "/api/memories", credential)).status,
			200,
			"AC2 positive pre-deactivation access",
		);
	const result = success(
		await request(fixture.daemon.origin, `/api/org/users/${bob.id}/deactivate`, fixture.admin, "POST", {
			mode: "keep",
			dryRun: false,
		}),
		"POST /api/org/users/:id/deactivate",
	);
	if (typeof result.jobId === "string") await fixture.waitJob(result.jobId);
	for (const credential of credentials) {
		const reply = await request(fixture.daemon.origin, "/api/memories", credential);
		assert.equal(reply.status, 401, "AC2 next request after deactivation must fail for every credential");
		assert(["revoked", "user_deactivated"].includes(String(record(reply.body).reason)));
	}
}
async function propagation(fixture: Fixture): Promise<void> {
	const user = fixture.user("carol");
	const quote = "atlas propagation-quokka retention award is 75000.";
	const source = await fixture.remember(user, quote);
	const derived = await deriveClaim(fixture, user.agentId, source, quote, "propagation-quokka");
	const path = `/api/memory/${derived.memoryId}?agent_id=default`;
	const before = await request(fixture.daemon.origin, path, fixture.user("alice").session);
	assert.equal(before.status, 200, "AC5 positive: derived claim must be visible before classification");
	assert(JSON.stringify(before.body).includes(quote));
	await fixture.classify("memory", source, user.agentId);
	const absent = await request(
		fixture.daemon.origin,
		"/api/memory/nonexistent-acceptance-id?agent_id=default",
		fixture.user("alice").session,
	);
	for (const restart of [false, true]) {
		if (restart) await fixture.daemon.restart();
		const hidden = await request(fixture.daemon.origin, path, fixture.user("alice").session);
		assert.equal(hidden.status, 404, "AC5 classify must hide cited claim before success and survive restart");
		assertUnchanged(absent.body, hidden.body, "AC5 hidden derived get-by-id equals absent");
		const visible = await request(fixture.daemon.origin, path, user.session);
		assert.equal(visible.status, 200, "AC5 HR audience still sees derived content");
		assert(JSON.stringify(visible.body).includes(quote));
	}
}
async function attribution(fixture: Fixture): Promise<void> {
	const alice = fixture.user("alice");
	const bob = fixture.user("bob");
	const shared = fixture.model === "single" ? "default" : fixture.engAgent;
	for (const user of [alice, bob]) {
		const key = await connector(fixture.daemon, user.session, user.deviceId, shared);
		await fixture.thread(
			{ ...user, agentId: shared, connector: key.credential },
			`org-speaker-${user.name}`,
			"I prefer dark mode and use a split keyboard.",
		);
	}
	const path = "/api/dream/tools/search_evidence";
	let evidence: Record<string, unknown> = {};
	await until(async () => {
		evidence = success(
			await request(fixture.daemon.origin, path, fixture.admin, "POST", {
				agentId: shared,
				input: { agentId: shared, query: "split keyboard", limit: 50 },
			}),
			`POST ${path}`,
		);
		return [alice, bob].every((user) => JSON.stringify(evidence).includes(user.id));
	}, "AC7 durable speaker-bound evidence capture");
	const serialized = JSON.stringify(evidence);
	for (const user of [alice, bob])
		assert(
			serialized.includes(user.id),
			"AC7 Dreaming evidence must carry credential-bound speaker, even without a name in the text",
		);
	await until(async () => {
		const result = await request(fixture.daemon.origin, `/api/knowledge/entities?agent_id=${shared}`, alice.session);
		const people = objects(result.body).filter(
			(row) =>
				(row.agentId ?? row.agent_id) === shared &&
				(row.person_user_id === alice.id ||
					row.personUserId === alice.id ||
					row.person_user_id === bob.id ||
					row.personUserId === bob.id),
		);
		return (
			new Set(people.map((row) => row.person_user_id ?? row.personUserId)).size === 2 &&
			new Set(people.map((row) => row.id)).size === 2
		);
	}, "AC7 distinct structural person entities for two unnamed shared-agent speakers");
}
function objects(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(objects);
	if (value !== null && typeof value === "object") {
		const row = record(value);
		return [row, ...Object.values(row).flatMap(objects)];
	}
	return [];
}

test("AC1 connector credentials cannot impersonate a user or unauthorized agent", () => withFixture(binding), 180_000);
test(
	"AC2 deactivation revokes all sessions and connector keys on the next request",
	() => withFixture(deactivate),
	180_000,
);
test("AC3 empty-scope non-admin legacy-team credential is rejected", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const secret = await readFile(join(daemon.workspace, "runtime/auth-secret"));
		const scoped = {
			bearer: createToken(secret, { sub: "scoped-positive", role: "agent", scope: { agent: "default" } }, 600),
		};
		assert.equal(
			(await request(daemon.origin, "/api/memories", scoped)).status,
			200,
			"AC3 scoped credential positive control",
		);
		const empty = { bearer: createToken(secret, { sub: "empty-scope", role: "agent", scope: {} }, 600) };
		const result = await request(daemon.origin, "/api/memories", empty);
		assert.equal(result.status, 401, "AC3 team-mode non-admin empty scope must fail closed");
		assert.equal(record(result.body).reason, "empty_scope");
	} finally {
		await daemon.dispose();
	}
}, 90_000);
test(
	"AC4 hidden HR evidence and derivations do not interfere with any read surface",
	() => withFixture(checkNoninterference),
	300_000,
);
test(
	"AC5 reclassification atomically hides cited claims and persists across restart",
	() => withFixture(propagation),
	240_000,
);
test(
	"AC6 native Dreaming write rejects a cross-agent citation before side effects",
	() =>
		withFixture(
			async (fixture) => {
				const quote = "cross-agent-evidence-quokka owns the payroll endpoint.";
				const source = await fixture.remember(fixture.user("alice"), quote);
				const target = fixture.user("bob").agentId;
				const before = normalize(
					(await request(fixture.daemon.origin, `/api/knowledge/entities?agent_id=${target}`, fixture.admin)).body,
				);
				const result = await request(
					fixture.daemon.origin,
					"/api/dream/tools/apply_ontology_ops",
					fixture.user("bob").session,
					"POST",
					{
						agentId: target,
						input: {
							agentId: target,
							operations: [
								{
									operation: "create_entity",
									payload: { name: "forbidden-cross-agent-quokka", type: "project" },
									evidence: [{ source_ref: `memory:${source}`, quote }],
								},
							],
						},
					},
				);
				assert.equal(result.status, 400, "AC6 valid native operation with foreign evidence must be rejected");
				assert.match(
					JSON.stringify(result.body),
					/belongs to scope.*targets|cross_agent|scope_mismatch|(?:another|different|cross).*?(?:agent|scope)|(?:agent|scope).*?(?:mismatch|another|different)/i,
					"AC6 must fail specifically for the foreign citation, not schema/auth/provider errors",
				);
				assertUnchanged(
					before,
					normalize(
						(await request(fixture.daemon.origin, `/api/knowledge/entities?agent_id=${target}`, fixture.admin)).body,
					),
					"AC6 rejected citation must not create graph nodes",
				);
				await deriveClaim(fixture, fixture.user("alice").agentId, source, quote, "allowed-same-agent-quokka");
			},
			"personal",
			false,
		),
	180_000,
);
test("AC7 unnamed speakers in one shared agent have distinct person entities", () => withFixture(attribution), 180_000);

const questions = [
	["Who owns the atlas API?", "alice", "API"],
	["Who owns atlas storage?", "bob", "storage"],
	["Who owns atlas release?", "carol", "release"],
	["Which database does atlas use?", "PostgreSQL"],
	["When does atlas ship?", "Friday"],
	["What is atlas service language?", "TypeScript"],
	["What atlas queue is used?", "Redis"],
	["What atlas region is used?", "us-east-1"],
	["What atlas test runner is used?", "Bun"],
	["Who reviews atlas deployments?", "eng"],
] as const;
test(
	"AC8 record ten fixed cross-agent atlas recall questions without gating on quality",
	() =>
		withFixture(async (fixture) => {
			const team = await connector(
				fixture.daemon,
				fixture.user("alice").session,
				fixture.user("alice").deviceId,
				fixture.engAgent,
			);
			await fixture.remember(
				{ ...fixture.user("alice"), agentId: fixture.engAgent, connector: team.credential },
				"Project atlas service language is TypeScript; queue is Redis; region is us-east-1; test runner is Bun; eng reviews deployments.",
			);
			const rows: { question: string; requiredFacts: readonly string[]; matchedFacts: string[]; passed: boolean }[] =
				[];
			for (const [question, ...requiredFacts] of questions) {
				const reply = await request(
					fixture.daemon.origin,
					"/api/memory/recall",
					fixture.user("alice").session,
					"POST",
					{ query: question, project: "atlas", agentId: "default", limit: 50, saveAggregate: false },
				);
				const payload = success(reply, "AC8 POST /api/memory/recall");
				assert(!payload.error, "AC8 recall returned an application error");
				assert(Array.isArray(payload.results), "AC8 recall must return a results array, including for zero hits");
				const context = payload.results
					.map((row) => {
						const content = record(row).content;
						assert(typeof content === "string", "AC8 recall result has no context content");
						return content;
					})
					.join("\n")
					.toLowerCase();
				const matchedFacts = requiredFacts.filter((fact) => context.includes(fact.toLowerCase()));
				rows.push({ question, requiredFacts, matchedFacts, passed: matchedFacts.length === requiredFacts.length });
			}
			const results = process.env.SIGNET_ORG_EVAL_OUTPUT_DIR ?? join(tmpdir(), "signet-org-mode-results");
			await mkdir(results, { recursive: true });
			await writeFile(
				join(results, "atlas-recall.json"),
				JSON.stringify(
					{
						model: fixture.model,
						questions: rows.length,
						correct: rows.filter((row) => row.passed).length,
						score: rows.filter((row) => row.passed).length / rows.length,
						rows,
					},
					null,
					2,
				),
			);
		}),
	180_000,
);
test(
	"AC9 single-agent organization preserves isolation, attribution, and revocation",
	() =>
		withFixture(async (fixture) => {
			for (const name of ["alice", "bob", "carol"])
				assert.equal(
					fixture.user(name).agentId,
					"default",
					"single-agent fixture must actually share one organization agent",
				);
			await binding(fixture);
			await checkNoninterference(fixture);
			await propagation(fixture);
			await attribution(fixture);
			await deactivate(fixture);
		}, "single"),
	420_000,
);
test("AC10 connect every supported harness without secrets in configs or process argv", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const registry = await packageRegistry(daemon.root);
		try {
			await connectorSecrets(await Fixture.createIdentity(daemon), registry.origin);
			assert(
				registry.requested.has("@signetai/signet-memory-openclaw"),
				"OpenClaw must install the real packed fixture plugin",
			);
		} finally {
			await registry.stop();
		}
	} finally {
		await daemon.dispose();
	}
}, 600_000);
