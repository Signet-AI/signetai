import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aliasProvider } from "./alias-provider";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { dreamOperation } from "./graph";
import { record, request, success, text, until } from "./http";

test("A20(g): classified aliases on public parents stay hidden through the real HTTP owner", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "single", false);
		const writer = fixture.user("carol");
		const publicQuote = "The Atlas project is public.";
		const secretQuote = "Atlas is internally called Compensation Review.";
		const publicMemory = await fixture.remember(writer, publicQuote);
		const secretMemory = await fixture.remember(writer, secretQuote);
		const parent = await dreamOperation(fixture, writer.agentId, "create_entity", { name: "Atlas", type: "project" }, [
			{ source_ref: `memory:${publicMemory}`, quote: publicQuote },
		]);
		const entityId = text(parent.entityId);
		const path = `/api/ontology/entities/${entityId}/aliases?agent_id=${writer.agentId}`;
		const reader = fixture.user("alice").session;
		const readBytes = async () => {
			const response = await fetch(`${daemon.origin}${path}`, {
				headers: { authorization: `Bearer ${text(reader.bearer)}` },
				signal: AbortSignal.timeout(30_000),
			});
			assert.equal(response.status, 200);
			return response.text();
		};
		const before = await readBytes();
		assert.deepEqual(record(JSON.parse(before)), { items: [] });
		success(
			await request(daemon.origin, "/api/ontology/operations/apply", writer.session, "POST", {
				agentId: writer.agentId,
				operation: "create_entity_alias",
				payload: { entity_id: entityId, alias: "Compensation Review" },
				evidence: [{ source_ref: `memory:${secretMemory}`, quote: secretQuote }],
			}),
			"Create evidence-backed alias through native owner",
		);
		await fixture.classify("memory", secretMemory, writer.agentId);
		const audience = success(await request(daemon.origin, path, writer.session), "Audience alias read");
		assert(Array.isArray(audience.items) && audience.items.length === 1);
		assert.equal(record(audience.items[0]).alias, "Compensation Review");
		assert.equal(JSON.stringify(audience).includes("compartment_id"), false);
		assert.equal(
			await readBytes(),
			before,
			"A non-audience reader must not learn a classified alias on a public parent",
		);
		assert.deepEqual(success(await request(daemon.origin, `${path}&status=all`, reader), "All-status alias read"), {
			items: [],
		});
		assert.deepEqual(
			success(
				await request(daemon.origin, `/api/ontology/entities/${entityId}/aliases?agent_id=${fixture.engAgent}`, reader),
				"Other-agent alias read",
			),
			{ items: [] },
		);
		success(
			await request(daemon.origin, `/api/knowledge/entities/${entityId}?agent_id=${writer.agentId}`, reader),
			"Public parent remains readable",
		);
	} finally {
		await daemon.dispose();
	}
}, 120_000);

test("A20(g): a running classified native Dreaming worker creates a hidden alias on a public parent", async () => {
	const daemon = await OrgDaemon.create();
	let provider: ReturnType<typeof aliasProvider> | undefined;
	const rows = (sql: string, ...args: (string | number | null)[]) => {
		const db = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
		try {
			return db
				.query(sql)
				.all(...args)
				.map(record);
		} finally {
			db.close();
		}
	};
	try {
		const fixture = await Fixture.create(daemon, "single", false);
		const writer = fixture.user("carol");
		const publicQuote = "The Atlas project is public.";
		const secretQuote = "Atlas is internally called Compensation Review.";
		const publicMemory = await fixture.remember(writer, publicQuote);
		const parent = await dreamOperation(fixture, writer.agentId, "create_entity", { name: "Atlas", type: "project" }, [
			{ source_ref: `memory:${publicMemory}`, quote: publicQuote },
		]);
		const entityId = text(parent.entityId);
		const parentBefore = rows("SELECT * FROM entities WHERE id=?", entityId);
		assert.equal(parentBefore[0]?.compartment_id, null);
		const secretMemory = await fixture.remember(writer, secretQuote, true);
		const compartment = rows("SELECT compartment_id FROM memories WHERE id=?", secretMemory)[0]?.compartment_id;
		assert(typeof compartment === "number");
		const path = `/api/ontology/entities/${entityId}/aliases?agent_id=${writer.agentId}`;
		const reader = fixture.user("alice").session;
		const readBytes = async (all = false) => {
			const response = await fetch(`${daemon.origin}${path}${all ? "&status=all" : ""}`, {
				headers: { authorization: `Bearer ${text(reader.bearer)}` },
				signal: AbortSignal.timeout(30_000),
			});
			assert.equal(response.status, 200);
			return response.text();
		};
		const before = await readBytes();
		const beforeAll = await readBytes(true);
		assert.deepEqual(record(JSON.parse(before)), { items: [] });
		provider = aliasProvider({
			agentId: writer.agentId,
			entityId,
			sourceRef: `memory:${secretMemory}`,
			quote: secretQuote,
			alias: "Compensation Review",
		});
		await daemon.stop();
		const offline = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			offline.exec(
				"CREATE TRIGGER alias_citation_atomicity_probe BEFORE INSERT ON evidence_citations WHEN NEW.derived_kind='alias' AND EXISTS(SELECT 1 FROM entity_aliases WHERE id=NEW.derived_id AND alias='Compensation Review rollback probe') BEGIN SELECT RAISE(ABORT,'alias_citation_atomicity_probe'); END",
			);
		} finally {
			offline.close();
		}
		const config = join(daemon.workspace, "agent.yaml");
		await writeFile(
			config,
			(await readFile(config, "utf8"))
				.replace(
					"dreaming:\n    enabled: false",
					"dreaming:\n    enabled: true\n    codemode: false\n    policies:\n      combined: |\n        Read evidence with search_evidence, record its explicit entity alias with apply_ontology_ops, review it, and commit an empty memory head.",
				)
				.replace("pipelineV2:\n    enabled: false", "pipelineV2:\n    enabled: true") +
				`\ninference:\n  defaultPolicy: fixture\n  targets:\n    fixture:\n      executor: openai-compatible\n      endpoint: http://127.0.0.1:${provider.server.port}/v1\n      models:\n        default:\n          model: fixture\n          contextWindow: 131072\n  policies:\n    fixture:\n      mode: strict\n      defaultTargets: [fixture/default]\n  workloads:\n    memoryExtraction:\n      target: fixture/default\n`,
		);
		await daemon.start();
		let passId = "";
		await until(
			async () => {
				const reply = await request(daemon.origin, "/api/dream/trigger", fixture.user("audra").session, "POST", {
					agentId: writer.agentId,
					compartmentId: compartment,
				});
				if (reply.status === 503) return false;
				passId = text(success(reply, "Trigger actual classified Dreaming worker").passId);
				return true;
			},
			"Native Dreaming readiness",
			60_000,
		);
		const active = provider;
		await until(async () => active.applied, "Provider receives successful canonical alias tool result", 60_000);
		const pass = rows("SELECT status,compartment_id FROM dreaming_passes WHERE id=?", passId)[0];
		assert.equal(pass?.status, "running");
		assert.equal(pass?.compartment_id, compartment);
		const audience = success(
			await request(daemon.origin, path, writer.session),
			"Classified audience sees actual worker alias",
		);
		assert(Array.isArray(audience.items) && audience.items.length === 1);
		assert.equal(record(audience.items[0]).alias, "Compensation Review");
		assert.equal(
			await readBytes(),
			before,
			"A running classified pass must not disclose its alias to a non-audience reader",
		);
		assert.equal(await readBytes(true), beforeAll);
		const aliasId = text(record(audience.items[0]).id);
		assert.deepEqual(
			rows(
				"SELECT a.compartment_id,a.dreaming_pass_id,c.evidence_kind,c.evidence_id FROM entity_aliases a LEFT JOIN evidence_citations c ON c.derived_kind='alias' AND c.derived_id=a.id AND c.agent_id=a.agent_id WHERE a.id=?",
				aliasId,
			),
			[{ compartment_id: compartment, dreaming_pass_id: passId, evidence_kind: "memory", evidence_id: secretMemory }],
			"The committed alias and citation are visible together with the worker-bound pass label",
		);
		assert.deepEqual(
			rows("SELECT * FROM entities WHERE id=?", entityId),
			parentBefore,
			"A19(b) alias creation leaves the public parent unchanged",
		);
		success(
			await request(daemon.origin, `/api/knowledge/entities/${entityId}?agent_id=${writer.agentId}`, reader),
			"Public parent remains readable during classified pass",
		);
		provider.release();
		await until(
			async () => {
				const status = rows("SELECT status,summary FROM dreaming_passes WHERE id=?", passId)[0];
				assert(!["failed", "cancelled"].includes(String(status?.status)), JSON.stringify(status));
				return status?.status === "completed";
			},
			"Actual classified pass completion",
			60_000,
		);
		assert(provider.citationRejected, "Actual worker received the injected citation-write rejection");
		assert.deepEqual(
			rows("SELECT id FROM entity_aliases WHERE alias='Compensation Review rollback probe'"),
			[],
			"A failed same-transaction citation insert must roll back the preceding alias insert",
		);
		assert.equal(await readBytes(), before);
		await daemon.restart();
		assert.equal(await readBytes(), before, "Hidden alias stays hidden after daemon restart");
		const afterRestart = success(await request(daemon.origin, path, writer.session), "Audience alias survives restart");
		assert.deepEqual(afterRestart, audience);
	} catch (error) {
		throw new Error(
			`${String(error)}\n${daemon.stdout}\n${daemon.stderr}\n${provider?.results.join("\n")}\n${provider?.requests.slice(-3).join("\n")}`,
			{ cause: error },
		);
	} finally {
		provider?.release();
		await provider?.server.stop(true);
		await daemon.dispose();
	}
}, 180_000);
