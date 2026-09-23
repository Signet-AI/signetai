import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor, runWriteTxAsync } from "../db-accessor";
import { getKnowledgeGraphForConstellation } from "../knowledge-graph";
import {
	invalidateDreamingEpisodicTokenBacklog,
	recordDreamingEpisodicTokenBacklog,
} from "../pipeline/dreaming-token-cache";
import { registerKnowledgeRoutes } from "./knowledge-routes";

async function seedEpisodicSources(count: number): Promise<void> {
	await runWriteTxAsync(getDbAccessor(), (db) => {
		const insert = db.prepare(
			`INSERT INTO memory_artifacts
			 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, is_deleted)
			 VALUES ('default', ?, ?, 'transcript', ?, ?, '2026-09-23T12:00:00.000Z', ?, '2026-09-23T12:00:00.000Z', 0)`,
		);
		for (let index = 0; index < count; index++) {
			const id = String(index).padStart(64, "0");
			insert.run(
				`sessions/constellation-${index}.md`,
				id,
				`session-${index}`,
				`token-${index}`,
				`evidence ${index} supports the current plan`,
			);
		}
	});
}

describe("GET /api/knowledge/constellation backlog measurement", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-constellation-route-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		invalidateDreamingEpisodicTokenBacklog("default");
		closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	test("marks a backlog probe capped after 50 sources instead of returning a partial exact count", async () => {
		await seedEpisodicSources(51);
		const app = new Hono();
		registerKnowledgeRoutes(app);

		const response = await app.request("/api/knowledge/constellation?agent_id=default");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			metadata: {
				dreaming: {
					episodicTokensPending: null,
					episodicBacklogProbe: {
						kind: "indeterminate",
					},
				},
			},
		});
		expect(body).not.toHaveProperty("metadata.dreaming.episodicBacklogProbe.tokenLowerBound");
	});

	test("keeps an exact pending-token count when the backlog fits within the probe limit", async () => {
		await seedEpisodicSources(1);
		const app = new Hono();
		registerKnowledgeRoutes(app);

		const response = await app.request("/api/knowledge/constellation?agent_id=default");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			metadata: {
				dreaming: {
					episodicTokensPending: expect.any(Number),
					episodicBacklogProbe: {
						kind: "exact",
					},
				},
			},
		});
	});

	test("does not pair an incomplete probe with an exact cached token total", async () => {
		recordDreamingEpisodicTokenBacklog("default", 12345);
		const graph = await getKnowledgeGraphForConstellation(getDbAccessor(), "default", {
			backlogProbe: {
				kind: "indeterminate",
				tokenLowerBound: 50,
				hasBacklog: true,
				sourcesScanned: 50,
			},
		});

		expect(graph.metadata.dreaming.episodicTokensPending).toBeNull();
		expect(graph.metadata.dreaming.episodicBacklogProbe?.kind).toBe("indeterminate");
	});

	test("uses the exact token total from the current probe", async () => {
		const graph = await getKnowledgeGraphForConstellation(getDbAccessor(), "default", {
			backlogProbe: {
				kind: "exact",
				tokens: 42,
				hasBacklog: true,
				sourcesScanned: 1,
			},
		});

		expect(graph.metadata.dreaming.episodicTokensPending).toBe(42);
		expect(graph.metadata.dreaming.episodicBacklogProbe?.kind).toBe("exact");
	});
});
