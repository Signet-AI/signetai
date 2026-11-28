import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { Hono } from "hono";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { record, request, success, text } from "./http";
import { loadRouteInventory, routeProbePaths } from "./route-inventory";

const evidenceTables = [
	"memories",
	"memory_artifacts",
	"session_transcripts",
	"session_summaries",
	"session_checkpoints",
	"documents",
	"cross_agent_messages",
];

function evidenceSnapshot(workspace: string): Record<string, string> {
	const db = new Database(join(workspace, "data/signet.db"), { readonly: true });
	try {
		return Object.fromEntries(
			evidenceTables.map((table) => {
				const rows = db
					.query(`SELECT * FROM ${table}`)
					.all()
					.map((row) => JSON.stringify(row))
					.sort();
				return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
			}),
		);
	} finally {
		db.close();
	}
}

test("every registered evidence mutation admits its classified destination before side effects", async () => {
	const inventory = await loadRouteInventory();
	const evidence = inventory.filter((route) => route.writesEvidence);
	assert(evidence.length > 0, "The effect inventory must explicitly tag evidence writers");
	for (const route of evidence) {
		assert(["POST", "PUT", "PATCH", "DELETE"].includes(route.method), `Non-mutation evidence tag: ${route.path}`);
		const matcher = new Hono();
		matcher.on(route.method, [...route.paths], (c) => c.json({ registered: route.path }));
		for (const path of routeProbePaths(route)) {
			const matched = await matcher.request(path, { method: route.method });
			assert.equal(matched.status, 200, `Probe does not match its registered route: ${route.path}`);
			assert.deepEqual(await matched.json(), { registered: route.path });
		}
	}
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const identity = success(await request(daemon.origin, "/api/auth/whoami", fixture.admin), "admin identity");
		assert.equal(record(identity.user).role, "admin");
		const writer = { session: fixture.admin, agentId: text(record(identity.agents).defaultWrite) };
		const visible = success(
			await request(daemon.origin, "/api/memory/remember", writer.session, "POST", {
				agentId: writer.agentId,
				content: "A16 sweep positive control: an admitted owner can write evidence.",
			}),
			"unclassified destination positive control",
		);
		assert(text(visible.id));
		await fixture.classify("agent", writer.agentId, writer.agentId);
		const before = evidenceSnapshot(daemon.workspace);
		const failures: string[] = [];
		let probes = 0;
		for (const route of evidence) {
			for (const path of routeProbePaths(route)) {
				const query = new URLSearchParams({ agentId: writer.agentId });
				const reply = await request(daemon.origin, `${path}?${query}`, writer.session, route.method, {
					agentId: writer.agentId,
					fromAgentId: writer.agentId,
					sessionKey: "a16-mechanical-sweep",
					harness: "codex",
					content: "This classified evidence must never be admitted.",
					userMessage: "This classified prompt must never be admitted.",
					lastAssistantMessage: "This classified assistant evidence must never be admitted.",
					summary: "This classified summary must never be admitted.",
				});
				probes += 1;
				if (reply.status !== 403 || record(reply.body).reason !== "classified_destination")
					failures.push(`${route.file}: ${route.method} ${path}: HTTP ${reply.status} ${JSON.stringify(reply.body)}`);
			}
		}
		assert.deepEqual(failures, [], "All evidence-writing registrations must enforce A16, not a different denial");
		assert.deepEqual(evidenceSnapshot(daemon.workspace), before, "Denied admissions changed persisted evidence");
		console.log(JSON.stringify({ registrations: inventory.length, evidenceRegistrations: evidence.length, probes }));
	} finally {
		await daemon.dispose();
	}
}, 180_000);
