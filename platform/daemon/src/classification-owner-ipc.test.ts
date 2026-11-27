import { withWritePrincipal } from "@signet/core";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { createDbOwnerClient } from "./db-owner-client";
import type { ClassificationRequest, ClassificationActor } from "./classifications";

test("real DB owner commits classifications and exposes terminal durable job state through IPC", async () => {
	const directory = mkdtempSync(join(tmpdir(), "signet-classification-owner-"));
	const dbPath = join(directory, "signet.db");
	const db = currentClassificationFixture();
	db.exec("UPDATE organization SET claimed_at='now',agent_model='single' WHERE id=1");
	db.prepare(
		"INSERT INTO embeddings(id,content_hash,vector,dimensions,source_type,source_id,agent_id,chunk_text,created_at) VALUES('v','v',?,3,'memory','m','default','secret','now')",
	).run(new Uint8Array(12));
	db.prepare("VACUUM INTO ?").run(dbPath);
	db.close();
	const owner = createDbOwnerClient({ dbPath });
	const actor: ClassificationActor = {
		local: false,
		userId: "carol",
		groupIds: [],
		compliance: true,
		boundAgentId: null,
		allowedProjects: null,
		credential: "session:test",
	};
	const request = (request: ClassificationRequest) =>
		withWritePrincipal(
			{ userId: "carol" },
			() =>
				owner.submit<unknown>(
					{ kind: "classification", request },
					{
						operation: `classification.${request.op}`,
						lane: "maintenance",
						workloadClass: "maintenance",
						deadlineMs: 120000,
						estimatedWorkUnits: 10000,
					},
				).result,
		);
	const field = (value: unknown, name: string) => {
		if (typeof value === "object" && value !== null) {
			const result: unknown = Reflect.get(value, name);
			if (typeof result === "string") return result;
		}
		throw new Error("invalid owner result");
	};
	try {
		await owner.start();
		const id = field(
			await request({
				op: "create",
				actor,
				name: "HR",
				color: null,
				description: null,
				audience: [{ kind: "user", id: "alice" }],
				appliers: [],
			}),
			"id",
		);
		const jobId = field(
			await request({
				op: "enqueue",
				actor,
				id,
				target: { kind: "memory", id: "m", agentId: "default" },
				remove: false,
			}),
			"jobId",
		);
		await request({ op: "execute", jobId });
		const state = await owner.submit(
			{
				kind: "query",
				statement: {
					sql: "SELECT j.status,m.compartment_id FROM org_jobs j JOIN memories m ON m.id='m' WHERE j.id=?",
					params: [jobId],
					result: "get",
					readonly: true,
				},
			},
			{ operation: "classification.verify", lane: "read", deadlineMs: 5000 },
		).result;
		expect(state).toMatchObject({ status: "complete", compartment_id: expect.any(Number) });
		expect(await request({ op: "readable", subject: { local: false, userId: "carol", groupIds: [] } })).toEqual([]);
	} finally {
		await owner.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
