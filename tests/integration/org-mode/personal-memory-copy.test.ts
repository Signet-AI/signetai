import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { record, text } from "./http";
import { parsePersonalMemories, personalMemoryCopy } from "../../../surfaces/dashboard/src/lib/personal-memory-copy";

test("selected personal export imports as attributable evidence with classified admission", async () => {
	const daemon = await OrgDaemon.create();
	let snapshot: Database | undefined;
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const alice = fixture.user("alice");
		snapshot = new Database(join(daemon.workspace, "data/signet.db"), { readonly: true });
		const original = [
			{
				id: "selected-personal",
				agent_id: "local-personal",
				content: "Preserve examples and provenance",
				created_at: "2026-01-01T00:00:00Z",
				who: "Original author",
				source_type: "manual",
				project: "personal-project",
			},
			{ id: "unselected-personal", agent_id: "local-personal", content: "Never upload this record" },
		]
			.map((row) => JSON.stringify(row))
			.join("\n");
		const rows = parsePersonalMemories(original);
		const before = snapshot.query("SELECT COUNT(*) AS n FROM memory_artifacts").get();
		const evidence = personalMemoryCopy(rows, ["selected-personal"], "local-personal");
		expect(snapshot.query("SELECT COUNT(*) AS n FROM memory_artifacts").get()).toEqual(before);
		const send = async (classificationId?: string) => {
			const form = new FormData();
			form.set("files", evidence);
			if (classificationId) form.set("classificationId", classificationId);
			const response = await fetch(`${daemon.origin}/api/sources/import?agentId=${encodeURIComponent(alice.agentId)}`, {
				method: "POST",
				headers: { authorization: `Bearer ${text(alice.session.bearer)}` },
				body: form,
				signal: AbortSignal.timeout(30_000),
			});
			return { status: response.status, body: record(await response.json()) };
		};
		const jobsBefore = snapshot.query("SELECT COUNT(*) AS n FROM document_import_jobs").get();
		const denied = await send(fixture.hrId);
		expect(denied.status).toBe(403);
		expect(snapshot.query("SELECT COUNT(*) AS n FROM document_import_jobs").get()).toEqual(jobsBefore);
		expect(snapshot.query("SELECT COUNT(*) AS n FROM memory_artifacts").get()).toEqual(before);
		const accepted = await send();
		expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
		if (!Array.isArray(accepted.body.files)) throw new Error("Missing import acknowledgement");
		const sourceId = text(record(accepted.body.files[0]).sourceId);
		const artifacts = snapshot
			.query("SELECT content, author_user_id, agent_id FROM memory_artifacts WHERE source_id=?")
			.all(sourceId);
		expect(artifacts.length).toBeGreaterThan(0);
		const serialized = JSON.stringify(artifacts);
		expect(serialized).toContain("selected-personal");
		expect(serialized).toContain("Original author");
		expect(serialized).toContain("2026-01-01T00:00:00Z");
		expect(serialized).not.toContain("unselected-personal");
		expect(serialized).not.toContain("Never upload this record");
		for (const artifact of artifacts)
			expect(artifact).toMatchObject({ author_user_id: alice.id, agent_id: alice.agentId });
		expect(
			snapshot.query("SELECT id FROM memories WHERE id IN ('selected-personal','unselected-personal')").all(),
		).toEqual([]);
		expect(rows).toHaveLength(2);
		expect(original).toContain("Never upload this record");
		expect((await send()).status).toBe(201);
		expect(snapshot.query("SELECT COUNT(*) AS n FROM memory_artifacts WHERE source_id=?").get(sourceId)).toEqual({
			n: artifacts.length,
		});
	} finally {
		snapshot?.close();
		await daemon.dispose();
	}
}, 120_000);
