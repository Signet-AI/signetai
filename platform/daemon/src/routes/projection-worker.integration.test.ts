import { contentRead } from "../content-read";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor, addObsidianSource } from "@signet/core";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import { localPrincipal, rolePermissions } from "../auth/principal";
import { initDbAccessor, closeDbAccessor, getDbAccessor } from "../db-accessor";
import { closeRegisteredDbOwnerMaintenance } from "../db-owner-maintenance";
import { classify } from "../classifications";
import { registerMemoryRoutes } from "./memory-routes";
import { registerSessionRoutes } from "./session-routes";
import { registerTelemetryRoutes } from "./telemetry-routes";
import { registerSourcesRoutes } from "./sources-routes";
import { registerTranscriptImportRoutes } from "./transcript-import-routes";

const previousPath = process.env.SIGNET_PATH;
const directory = mkdtempSync(join(tmpdir(), "org-read-routes-"));
const at = "2026-11-25T00:00:00.000Z";
let app: Hono;
let compartment: number | null;
let sourceId: string;

beforeAll(async () => {
	process.env.SIGNET_PATH = directory;
	mkdirSync(join(directory, "memory"));
	writeFileSync(join(directory, "agent.yaml"), "embedding:\n  provider: none\nauth:\n  mode: local\n");
	const state = await import("./state");
	state.reloadAuthState(directory);
	initDbAccessor(join(directory, "memory", "memories.db"));
	getDbAccessor().withWriteTx((db) => {
		for (const id of ["default", "alpha", "beta"])
			db.prepare("INSERT OR IGNORE INTO agents (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(id, id, at, at);
		db.prepare("UPDATE agents SET kind='organization' WHERE id='default'").run();
		db.prepare("UPDATE agents SET kind='personal',owner_user_id='alice' WHERE id='alpha'").run();
		db.prepare("UPDATE agents SET kind='personal',owner_user_id='bob' WHERE id='beta'").run();
		db.prepare("INSERT INTO classifications(id,name,created_at,updated_at) VALUES ('cls_hr','HR',?,?)").run(at, at);
		db.prepare("INSERT INTO classification_audience VALUES ('cls_hr','user','carol')").run();
		compartment = compartmentFor(db, ["cls_hr"]);
	});
	const org = await readOrganization();
	app = new Hono();
	app.use("*", async (c, next) => {
		const role =
			c.req.path === "/api/embeddings/projection" || c.req.header("x-test-admin") === "1"
				? ("admin" as const)
				: ("operator" as const);
		const principal = {
			...localPrincipal(),
			kind: "user" as const,
			userId: c.req.header("x-test-user") ?? "alice",
			role,
			permissions: new Set(
				[...rolePermissions(role)].filter(
					(permission) => c.req.header("x-test-no-recall") !== "1" || permission !== "recall",
				),
			),
		};
		bindPrincipalAccess(principal, {
			agentModel: "personal",
			personalAgentsSelfService: true,
			organizationAgentId: "default",
			personalAgentId: principal.userId === "bob" ? "beta" : "alpha",
			defaultReadAgentId: c.req.header("x-test-personal-default") === "1" ? "alpha" : null,
			agents: [
				{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
				{ id: "alpha", kind: "personal", owner_user_id: "alice", owner_group_id: null, archived_at: null },
				{ id: "beta", kind: "personal", owner_user_id: "bob", owner_group_id: null, archived_at: null },
			],
		});
		c.set("principal", principal);
		c.set("author", { userId: principal.userId, credential: "local" });
		c.set("organization", org);
		await next();
	});
	registerMemoryRoutes(app, { fetchEmbedding: async () => null });
	registerSessionRoutes(app, {
		gitConfig: {
			enabled: false,
			autoCommit: false,
			autoSync: false,
			syncInterval: 300,
			remote: "origin",
			branch: "main",
		},
		stopGitSyncTimer: async () => {},
		startGitSyncTimer: () => {},
		getGitStatus: async () => ({}),
		gitPull: async () => ({}),
		gitPush: async () => ({}),
		gitSync: async () => ({}),
	});
	registerTelemetryRoutes(app);
	const vault = join(directory, "vault");
	mkdirSync(vault);
	const source = addObsidianSource({ root: vault, name: "Atlas" }, directory);
	if (!source.ok) throw new Error(source.error);
	sourceId = source.source.id;
	registerSourcesRoutes(app, { agentsDir: directory });
	registerTranscriptImportRoutes(app);
	seed("visible", null);
});

afterAll(async () => {
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(directory, { recursive: true, force: true });
});

function seed(id: string, label: number | null): void {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO memories(id,type,content,created_at,updated_at,updated_by,agent_id,visibility,author_user_id,compartment_id) VALUES (?,'fact',?,?,?,'fixture','beta','private','bob',?)",
			)
			.run(id, `atlas reading ${id}`, at, at, label),
	);
}
async function request(path: string, user = "alice", admin = false) {
	const response = await app.request(`http://localhost${path}`, {
		headers: { "x-test-user": user, "x-test-admin": admin ? "1" : "0" },
	});
	const raw = await response.text();
	const body =
		path.includes("blackbox") || path.includes("timeline")
			? JSON.stringify(JSON.parse(raw), (key, value) =>
					["generatedAt", "generatedFor"].includes(key) ? undefined : value,
				)
			: raw;
	return { status: response.status, headers: [...response.headers], body };
}

test("B1 5000-point projection keeps maximum event-loop gap under 50ms", async () => {
	getDbAccessor().withWriteTx((db) => {
		const m = db.prepare(
			"INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by) VALUES (?,'beta','fact','worker projection','global',?,?,'test')",
		);
		const e = db.prepare(
			"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES (?,'memory',?,?,'c',?,768,?,'beta')",
		);
		for (let i = 0; i < 5000; i++) {
			const id = `b1-${i}`;
			m.run(id, at, at);
			e.run(
				id,
				id,
				id,
				Buffer.from(Float32Array.from({ length: 768 }, (_, n) => Math.sin(i * 0.37 + n * 0.11)).buffer),
				at,
			);
		}
	});
	const { projectVisibleMemories } = await import("../umap-projection");
	const { resolveReadScope } = await import("../read-scope");
	const scope = await resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	let maximum = 0,
		last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		maximum = Math.max(maximum, now - last - 10);
		last = now;
	}, 10);
	try {
		const result = await projectVisibleMemories(scope, 2, { limit: 5000 });
		expect(result.count).toBe(5000);
	} finally {
		clearInterval(timer);
	}
	console.log("B1_MAX_EVENT_LOOP_GAP_MS", maximum);
	expect(maximum).toBeLessThan(50);
}, 120000);

test("B4 cached geometry never caches readable population totals", async () => {
	const { projectVisibleMemories } = await import("../umap-projection");
	const { resolveReadScope } = await import("../read-scope");
	const scope = await resolveReadScope(
		{ reach: { kind: "all" }, projects: null },
		{ local: false, userId: "bob", groupIds: [] },
	);
	const before = await projectVisibleMemories(scope, 2, { limit: 3 });
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by) VALUES ('b4-old','beta','fact','old','global','2020-01-01',?,'test')",
		).run(at);
		db.prepare(
			"INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES ('b4-old','memory','b4-old','b4-old','old',?,3,?,'beta')",
		).run(Buffer.from(new Float32Array([1, 2, 3]).buffer), at);
	});
	const after = await projectVisibleMemories(scope, 2, { limit: 3 });
	expect(after.result).toEqual(before.result);
	expect(after.total).toBe(before.total + 1);
});
