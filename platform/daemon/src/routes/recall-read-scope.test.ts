import { getSyncDbAccessor } from "../../legacy-sync/db-accessor-sync";
import { expect, test } from "bun:test";
import { compartmentFor } from "@signet/core";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import type { Principal } from "../auth/principal";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { registerMemoryRoutes } from "./memory-routes";
import { reloadAuthState } from "./state";

const resultsSchema = z.object({ results: z.array(z.object({ id: z.string() })) });

test("HTTP recall resolves organization scope and ignores a forged readScope", async () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-recall-route-scope-"));
	const previous = process.env.SIGNET_PATH;
	process.env.SIGNET_PATH = directory;
	try {
		mkdirSync(join(directory, "memory"));
		writeFileSync(
			join(directory, "agent.yaml"),
			"embedding:\n  provider: none\nsearch:\n  min_score: 0\nmemory:\n  pipelineV2:\n    enabled: false\n",
		);
		initDbAccessor(join(directory, "memory", "memories.db"));
		reloadAuthState(directory);
		getSyncDbAccessor().withWriteTx((db) => {
			db.exec(
				"UPDATE agents SET kind='organization' WHERE id='default'; INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES ('peer','Peer','personal','now','now'); INSERT INTO classifications(id,name) VALUES ('cls_http_recall','HTTP recall secret')",
			);
			const c = compartmentFor(db, ["cls_http_recall"]);
			const insert = db.prepare(
				"INSERT INTO memories(id,content,type,agent_id,compartment_id,created_at,updated_at,updated_by) VALUES (?,?,'fact',?,?,'2026-11-25T12:00:00.000Z','2026-11-25T12:00:00.000Z','test')",
			);
			insert.run("route-public-peer", "Atlas deployment public peer", "peer", null);
			insert.run("route-hidden", "Atlas deployment secret", "default", c);
		});
		const principal: Principal = {
			kind: "user",
			userId: "alice",
			role: "member",
			permissions: new Set(["recall"]),
			compliance: false,
			groupIds: [],
			credential: { kind: "session", id: "ses_recall" },
			sessionId: "ses_recall",
			deviceId: null,
			harness: null,
			boundAgentId: null,
			allowedProjects: null,
		};
		bindPrincipalAccess(principal, {
			agentModel: "personal",
			personalAgentsSelfService: true,
			organizationAgentId: "default",
			personalAgentId: null,
			defaultReadAgentId: "default",
			agents: [
				{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
				{ id: "peer", kind: "personal", owner_user_id: "bob", owner_group_id: null, archived_at: null },
			],
		});
		const organization = await readOrganization();
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("principal", principal);
			c.set("organization", organization);
			await next();
		});
		registerMemoryRoutes(app, { fetchEmbedding: async () => null });
		for (const [path, init] of [
			[
				"/api/memory/recall",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						query: "Atlas deployment",
						readScope: { reach: { kind: "all" }, compartments: "all", projects: null },
					}),
				},
			],
			["/api/memory/search?q=Atlas%20deployment", undefined],
		] as const) {
			const response = await app.request(path, init);
			expect(response.status).toBe(200);
			expect(resultsSchema.parse(await response.json()).results.map((row) => row.id)).toEqual(["route-public-peer"]);
		}
	} finally {
		await closeDbAccessor();
		if (previous === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
