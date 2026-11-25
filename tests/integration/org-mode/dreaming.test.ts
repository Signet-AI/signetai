import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
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
					pass.status,
					"failed",
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

for (const model of ["personal", "single"] as const)
	test(`AC7 and AC9 Dreaming: unnamed shared-agent people and classified completion (${model})`, async () => {
		const daemon = await OrgDaemon.create();
		let shared = "";
		const provider = deterministicProvider(() => shared);
		try {
			const fixture = await Fixture.create(daemon, model, false);
			shared = model === "single" ? "default" : fixture.engAgent;
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
			await daemon.stop();
			const config = join(daemon.workspace, "agent.yaml");
			await writeFile(
				config,
				(await readFile(config, "utf8"))
					.replace("dreaming:\n    enabled: false", "dreaming:\n    enabled: true\n    codemode: false")
					.replace("pipelineV2:\n    enabled: false", "pipelineV2:\n    enabled: true") +
					`\ninference:\n  defaultPolicy: fixture\n  targets:\n    fixture:\n      executor: openai-compatible\n      endpoint: http://127.0.0.1:${provider.server.port}/v1\n      models:\n        default:\n          model: fixture\n          contextWindow: 131072\n  policies:\n    fixture:\n      mode: strict\n      defaultTargets: [fixture/default]\n  workloads:\n    memoryExtraction:\n      target: fixture/default\n`,
			);
			await daemon.start();
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
						"SELECT id,person_user_id,compartment_id FROM entities WHERE agent_id=? AND person_user_id IS NOT NULL ORDER BY person_user_id",
					)
					.all(shared)
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
						compartmentId,
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
