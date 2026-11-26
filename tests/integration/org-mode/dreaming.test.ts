import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { claimProvider, type ClaimTarget } from "./claim-provider";
import { connector, Fixture } from "./fixture";
import { record, request, success, text, until, type Credential } from "./http";

function deterministicProvider(currentAgent: () => string) {
	const outputs: string[] = [];
	const requests: string[] = [];
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "HEAD") return new Response(null);
			if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
			const body = record(await request.json());
			const messages = Array.isArray(body.messages) ? body.messages.map(record) : [];
			for (const message of messages) if (message.role === "tool") outputs.push(JSON.stringify(message));
			const called = new Set(
				messages.flatMap((message) =>
					Array.isArray(message.tool_calls)
						? message.tool_calls.map((call) => text(record(record(call).function).name))
						: [],
				),
			);
			const available = new Set(
				Array.isArray(body.tools) ? body.tools.map((tool) => text(record(record(tool).function).name)) : [],
			);
			requests.push(
				JSON.stringify({ path: new URL(request.url).pathname, tools: [...available], keys: Object.keys(body) }),
			);
			const name = ["search_evidence", "memory_head_read", "memory_head_commit"].find(
				(name) => available.has(name) && !called.has(name),
			);
			const delta = name
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `fixture-${++calls}`,
								type: "function",
								function: {
									name,
									arguments: JSON.stringify({
										agentId: currentAgent(),
										...(name === "memory_head_commit" ? { entries: [] } : {}),
									}),
								},
							},
						],
					}
				: { role: "assistant", content: "Deterministic Dreaming completed." };
			const chunk = (delta: object, finish_reason: string | null) =>
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			return new Response(`${chunk(delta, null)}${chunk({}, name ? "tool_calls" : "stop")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	return { server, outputs, requests };
}

async function completePass(
	daemon: OrgDaemon,
	credential: Credential,
	agentId: string,
	compartmentId?: number,
): Promise<string> {
	let accepted: Record<string, unknown> = {};
	await until(
		async () => {
			const reply = await request(daemon.origin, "/api/dream/trigger", credential, "POST", {
				agentId,
				...(compartmentId === undefined ? {} : { compartmentId }),
			});
			if (reply.status === 503) return false;
			accepted = success(reply, `Trigger deterministic Dreaming: ${daemon.stdout.slice(-2500)}`);
			return true;
		},
		"Dreaming worker and inference readiness",
		60_000,
	);
	const passId = text(accepted.passId);
	await until(
		async () => {
			const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			try {
				const pass = record(db.query("SELECT status,summary FROM dreaming_passes WHERE id=?").get(passId));
				assert.notEqual(
					["failed", "cancelled"].includes(String(pass.status)),
					true,
					`${JSON.stringify(pass)} ${daemon.stdout.slice(-5000)} ${daemon.stderr}`,
				);
				return pass.status === "completed";
			} finally {
				db.close();
			}
		},
		"Classified/native pass durable completion",
		60_000,
	);
	return passId;
}

async function enableDreaming(daemon: OrgDaemon, port: number): Promise<void> {
	await daemon.stop();
	const config = join(daemon.workspace, "agent.yaml");
	await writeFile(
		config,
		(await readFile(config, "utf8"))
			.replace("dreaming:\n    enabled: false", "dreaming:\n    enabled: true\n    codemode: false")
			.replace("pipelineV2:\n    enabled: false", "pipelineV2:\n    enabled: true") +
			`\ninference:\n  defaultPolicy: fixture\n  targets:\n    fixture:\n      executor: openai-compatible\n      endpoint: http://127.0.0.1:${port}/v1\n      models:\n        default:\n          model: fixture\n          contextWindow: 131072\n  policies:\n    fixture:\n      mode: strict\n      defaultTargets: [fixture/default]\n  workloads:\n    memoryExtraction:\n      target: fixture/default\n`,
	);
	await daemon.start();
}

for (const model of ["personal", "single"] as const)
	test(`AC7 and AC9 Dreaming: unnamed shared-agent people and classified completion (${model})`, async () => {
		const daemon = await OrgDaemon.create();
		let shared = "";
		const provider = deterministicProvider(() => shared);
		try {
			const fixture = await Fixture.create(daemon, model, false);
			shared = model === "single" ? "default" : fixture.engAgent;
			for (const name of ["alice", "bob"])
				success(
					await request(daemon.origin, `/api/org/users/${fixture.user(name).id}`, fixture.admin, "PATCH", {
						displayName: "Alex",
					}),
					"Disambiguate structural identity names",
				);
			const identities = readRows(
				daemon,
				"SELECT * FROM entities WHERE agent_id=? AND person_user_id IN (?,?) ORDER BY person_user_id",
				shared,
				fixture.user("alice").id,
				fixture.user("bob").id,
			);
			assert.equal(identities.length, 2, "Both structural people exist before evidence or Dreaming");
			assert.deepEqual(identities.map((person) => person.name).sort(), ["Alex (alice)", "Alex (bob)"]);
			assert(identities.every((person) => person.compartment_id === null));
			for (const name of ["alice", "bob"]) {
				const user = fixture.user(name);
				const key = await connector(daemon, user.session, user.deviceId, shared);
				const writer = { ...user, agentId: shared, connector: key.credential };
				const disclosure =
					name === "alice"
						? "I prefer dark mode and use a split keyboard."
						: "I prefer light mode and use a mechanical keyboard.";
				await fixture.thread(writer, `speaker-${name}`, disclosure);
				await fixture.remember(writer, disclosure);
			}
			const admin = success(
				await request(daemon.origin, "/api/auth/whoami", fixture.admin),
				"Read administrator identity",
			);
			success(
				await request(
					daemon.origin,
					`/api/org/groups/${fixture.engId}/members/${text(record(admin.user).id)}`,
					fixture.admin,
					"PUT",
					{ role: "member" },
				),
				"Authorize administrator for shared Dreaming",
			);
			await enableDreaming(daemon, provider.server.port);
			await until(
				async () => {
					const reply = await request(
						daemon.origin,
						"/api/dream/tools/search_evidence",
						fixture.user("alice").session,
						"POST",
						{ agentId: shared, input: { agentId: shared, query: "keyboard", limit: 50 } },
					);
					return (
						reply.status === 200 &&
						[fixture.user("alice").id, fixture.user("bob").id].every((id) => JSON.stringify(reply.body).includes(id))
					);
				},
				"Both connector-authored sources are delivered as Dreaming evidence",
				60_000,
			);
			await completePass(daemon, fixture.admin, shared);
			const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
			try {
				const people = db
					.query(
						"SELECT id,person_user_id,compartment_id FROM entities WHERE agent_id=? AND person_user_id IN (?,?) ORDER BY person_user_id",
					)
					.all(shared, fixture.user("alice").id, fixture.user("bob").id)
					.map(record);
				assert.deepEqual(
					people.map((person) => person.person_user_id).sort(),
					[fixture.user("alice").id, fixture.user("bob").id].sort(),
				);
				assert.equal(new Set(people.map((person) => person.id)).size, 2);
				for (const person of people)
					assert(
						provider.outputs.some(
							(output) => output.includes(text(person.id)) && output.includes(text(person.person_user_id)),
						),
						"Actual provider must receive each trusted person identity",
					);
			} finally {
				db.close();
			}
			if (model === "single") {
				const reader = fixture.user("alice").session;
				const read = async () =>
					success(
						await request(daemon.origin, "/api/dream/tools/search_entities", reader, "POST", {
							agentId: shared,
							input: { agentId: shared, limit: 100 },
						}),
						"Unclassified graph reader",
					);
				const before = await read();
				const secret = await fixture.remember(
					fixture.user("audra"),
					"classifiedDreamingQuokka confidential payroll detail",
				);
				await fixture.classify("memory", secret, shared);
				const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
				let compartmentId: number;
				try {
					const value = record(db.query("SELECT compartment_id FROM memories WHERE id=?").get(secret)).compartment_id;
					assert(typeof value === "number");
					compartmentId = value;
				} finally {
					db.close();
				}
				const denied = await request(daemon.origin, "/api/dream/trigger", fixture.admin, "POST", {
					agentId: shared,
					compartmentId,
				});
				const absent = await request(daemon.origin, "/api/dream/trigger", fixture.admin, "POST", {
					agentId: shared,
					compartmentId: 2147483647,
				});
				assert.equal(denied.status, 403);
				assert.deepEqual(
					denied.body,
					absent.body,
					"A forbidden partition is indistinguishable from an unknown partition",
				);
				const privatePass = await completePass(daemon, fixture.user("audra").session, shared, compartmentId);
				assert(
					provider.outputs.some((output) => output.includes(secret) && output.includes("classifiedDreamingQuokka")),
					"The completed pass actually received classified evidence",
				);
				const persisted = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
				try {
					assert.equal(
						record(persisted.query("SELECT compartment_id FROM dreaming_passes WHERE id=?").get(privatePass))
							.compartment_id,
						compartmentId,
					);
					assert.equal(
						record(
							persisted
								.query("SELECT compartment_id FROM entities WHERE agent_id=? AND person_user_id=?")
								.get(shared, fixture.user("audra").id),
						).compartment_id,
						null,
					);
				} finally {
					persisted.close();
				}
				assert.deepEqual(
					await read(),
					before,
					"An actually completed classified pass must not change the unclassified graph response",
				);
				await daemon.restart();
				assert.deepEqual(await read(), before, "Classified completion stays invisible after a real daemon restart");
			}
		} catch (error) {
			throw new Error(
				`${String(error)}\n${daemon.stdout}\n${daemon.stderr}\n${provider.requests.join("\n")}\n${provider.outputs.join("\n")}`,
				{ cause: error },
			);
		} finally {
			provider.server.stop(true);
			await daemon.dispose();
		}
	}, 180_000);

function readRows(daemon: OrgDaemon, sql: string, ...args: (string | number | null)[]): Record<string, unknown>[] {
	const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
	try {
		return db
			.query(sql)
			.all(...args)
			.map(record);
	} finally {
		db.close();
	}
}

async function graphBytes(daemon: OrgDaemon, credential: Credential, entityId: string): Promise<string[]> {
	const base = `/api/knowledge/entities/${entityId}`;
	const read = async (path: string) => {
		const response = await fetch(`${daemon.origin}${path}?agent_id=default`, {
			headers: credential.bearer ? { authorization: `Bearer ${credential.bearer}` } : {},
			signal: AbortSignal.timeout(30_000),
		});
		const raw = await response.text();
		assert.equal(response.status, 200, `${path}: ${raw}`);
		return raw;
	};
	const entity = await read(base);
	const aspects = await read(`${base}/aspects`);
	const items = record(JSON.parse(aspects)).items;
	assert(Array.isArray(items));
	const attributes = await Promise.all(
		items.map((item) => read(`${base}/aspects/${text(record(record(item).aspect).id)}/attributes`)),
	);
	return [entity, aspects, ...attributes];
}

for (const order of ["public-first", "secret-first"] as const)
	test(`A17 A19 native claims keep one structural root and independent labels (${order})`, async () => {
		const daemon = await OrgDaemon.create();
		const provider = claimProvider();
		try {
			const fixture = await Fixture.create(daemon, "single", false);
			const author = fixture.user("audra");
			const reader = fixture.user("alice").session;
			const roots = () =>
				readRows(daemon, "SELECT * FROM entities WHERE agent_id='default' AND person_user_id=?", author.id);
			assert.equal(roots().length, 1, "Grant creates exactly one identity before evidence");
			const root = roots()[0];
			assert(root);
			assert.equal(root.compartment_id, null);
			const entityId = text(root.id);
			const before = await graphBytes(daemon, reader, entityId);
			const publicQuote = "I prefer peppermint tea.";
			const secretQuote = "I prefer confidential saffron tea.";
			const labels = order === "public-first" ? ["public", "secret"] : ["secret", "public"];
			const memoryIds = new Map<string, string>();
			for (const label of labels)
				memoryIds.set(
					label,
					await fixture.remember(author, label === "public" ? publicQuote : secretQuote, label === "secret"),
				);
			const publicId = memoryIds.get("public");
			const secretId = memoryIds.get("secret");
			assert(publicId && secretId);
			const publicTarget: ClaimTarget = {
				agentId: "default",
				sourceRef: `memory:${publicId}`,
				quote: publicQuote,
				value: publicQuote,
			};
			const secret: ClaimTarget = {
				agentId: "default",
				sourceRef: `memory:${secretId}`,
				quote: secretQuote,
				value: secretQuote,
			};
			const compartment = readRows(daemon, "SELECT compartment_id FROM memories WHERE id=?", secretId)[0]
				?.compartment_id;
			assert(typeof compartment === "number");
			await enableDreaming(daemon, provider.server.port);
			await daemon.stop();
			const dbPath = join(daemon.workspace, "data/signet.db");
			const snapshot = join(daemon.root, "before-passes.db");
			await copyFile(dbPath, snapshot);
			await daemon.start();
			let publicCheckpoint: string[] | undefined;
			let publicEvidence: string[] | undefined;
			let publicEnvelope: string | undefined;
			const assertRoot = () => {
				assert.deepEqual(roots(), [root], "A child write must not change any structural person column");
				assert.equal(
					readRows(
						daemon,
						"SELECT * FROM evidence_citations WHERE agent_id='default' AND derived_kind='entity' AND derived_id=?",
						entityId,
					).length,
					0,
					"Person root has no evidence citation",
				);
			};
			const pass = async (target: ClaimTarget, compartmentId?: number) => {
				provider.select(target);
				let passId = "";
				for (let attempt = 0; attempt < 3; attempt++) {
					passId = await completePass(daemon, author.session, "default", compartmentId);
					if (provider.results.some((result) => result.includes('"attributeId"'))) break;
				}
				assert(
					provider.results.some((result) => result.includes('"attributeId"')),
					`A real graph pass must file a claim: ${provider.results.join("\n")}`,
				);
				assert(provider.evidence.length > 0, "Provider received actual evidence tool content");
				assertRoot();
				return JSON.stringify(readRows(daemon, "SELECT status,summary FROM dreaming_passes WHERE id=?", passId));
			};
			for (const label of labels) {
				const target = label === "public" ? publicTarget : secret;
				const envelope = await pass(target, label === "secret" ? compartment : undefined);
				if (label === "secret") {
					assert.deepEqual(
						await graphBytes(daemon, reader, entityId),
						publicCheckpoint ?? before,
						"Private facts never change public HTTP bytes",
					);
				} else {
					publicCheckpoint = await graphBytes(daemon, reader, entityId);
					assert(publicCheckpoint.join("").includes(target.value));
					publicEnvelope = envelope;
					publicEvidence = [...provider.evidence];
				}
			}
			const audience = (await graphBytes(daemon, author.session, entityId)).join("");
			assert(
				audience.includes(secret.value) && audience.includes(publicTarget.value),
				"Audience sees both labels beneath one person",
			);
			const publicBytes = await graphBytes(daemon, reader, entityId);
			assert(publicBytes.join("").includes(publicTarget.value));
			assert(!publicBytes.join("").includes(secret.value));
			const children = readRows(
				daemon,
				"SELECT a.compartment_id,a.content FROM entity_attributes a JOIN entity_aspects s ON s.id=a.aspect_id WHERE s.entity_id=? ORDER BY a.content",
				entityId,
			);
			assert.equal(children.length, 2);
			assert.equal(children.find((child) => child.content === publicTarget.value)?.compartment_id, null);
			assert.equal(typeof children.find((child) => child.content === secret.value)?.compartment_id, "number");
			await daemon.restart();
			assertRoot();
			assert.deepEqual(
				await graphBytes(daemon, reader, entityId),
				publicBytes,
				"Public HTTP bytes survive restart after both labels",
			);
			await daemon.stop();
			await rm(`${dbPath}-wal`, { force: true });
			await rm(`${dbPath}-shm`, { force: true });
			await copyFile(snapshot, dbPath);
			await daemon.start();
			assert.deepEqual(
				await graphBytes(daemon, reader, entityId),
				before,
				"Snapshot restores exactly the prepass public HTTP body",
			);
			if (order === "public-first") {
				await pass(secret, compartment);
				assert.deepEqual(
					await graphBytes(daemon, reader, entityId),
					before,
					"Private predecessor leaves every public HTTP body byte unchanged",
				);
			}
			assert.equal(
				await pass(publicTarget),
				publicEnvelope,
				"Initial public pass status and summary bytes ignore private predecessor",
			);
			assert.deepEqual(
				provider.evidence,
				publicEvidence,
				"Actual public evidence tool content bytes ignore private predecessor without normalization",
			);
			const controlPublicBytes = await graphBytes(daemon, reader, entityId);
			assert(controlPublicBytes.join("").includes(publicTarget.value));
			assert(!controlPublicBytes.join("").includes(secret.value));
			if (order === "secret-first") {
				await pass(secret, compartment);
				assert.deepEqual(
					await graphBytes(daemon, reader, entityId),
					controlPublicBytes,
					"Private successor leaves stable public child HTTP bodies byte-identical",
				);
			}
			await daemon.restart();
			assertRoot();
			assert.deepEqual(
				await graphBytes(daemon, reader, entityId),
				controlPublicBytes,
				"Control public HTTP bodies survive restart",
			);
		} catch (error) {
			throw new Error(
				`${String(error)}\n${daemon.stdout}\n${daemon.stderr}\n${provider.results.join("\n")}\n${provider.requests.slice(-4).join("\n")}`,
				{ cause: error },
			);
		} finally {
			await provider.server.stop(true);
			await daemon.dispose();
		}
	}, 240_000);
