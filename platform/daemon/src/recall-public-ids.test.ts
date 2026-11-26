import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { compartmentFor, ensureCompartmentShards } from "@signet/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { bindPrincipalAccess } from "./auth/agent-access";
import { readOrganization } from "./auth/organization-store";
import { localPrincipal, type Principal } from "./auth/principal";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import { telemetryEvidenceInTx } from "./session-recall-dedupe";

const timestamp = "2026-11-25T12:00:00.000Z";
const previousPath = process.env.SIGNET_PATH;
const previousFetch = globalThis.fetch;
let root = "";
let createMcpServer: typeof import("./mcp/tools").createMcpServer;
let registerHooksRoutes: typeof import("./routes/hooks-routes").registerHooksRoutes;
let registerMemoryRoutes: typeof import("./routes/memory-routes").registerMemoryRoutes;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "signet-recall-public-ids-"));
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(
		join(root, "agent.yaml"),
		"name: Public ids\nembedding:\n  provider: none\nsearch:\n  rehearsal_enabled: false\n  min_score: 0\nmemory:\n  pipelineV2:\n    telemetry:\n      memorySearchQaEnabled: true\n    reranker:\n      enabled: false\n",
	);
	process.env.SIGNET_PATH = root;
	({ createMcpServer } = await import("./mcp/tools"));
	({ registerHooksRoutes } = await import("./routes/hooks-routes"));
	({ registerMemoryRoutes } = await import("./routes/memory-routes"));
});

afterAll(() => {
	globalThis.fetch = previousFetch;
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(root, { recursive: true, force: true });
});

function readerPrincipal(userId: string): Principal {
	return {
		...localPrincipal(),
		kind: "user",
		userId,
		role: "operator",
		credential: { kind: "session", id: `session:${userId}` },
	};
}

function insertArtifact(prefix: string, kind: "native_memory" | "transcript", compartment: number | null): void {
	getSyncDbAccessor().withWriteTx((db) => {
		db.prepare(
			"INSERT INTO memory_artifacts(agent_id,source_path,source_sha256,source_kind,session_id,session_key,session_token,harness,captured_at,content,updated_at,compartment_id,source_node_id) VALUES ('default',?,?,?,?,?,?,'codex',?,?,?,?,?)",
		).run(
			`${prefix}/${kind}.md`,
			`${prefix}-${kind}-hash`,
			kind,
			`${prefix}-session`,
			`${prefix}-session`,
			`${prefix}-token`,
			timestamp,
			`user: Zephyr rollout cadence ${prefix} ${kind} document`,
			timestamp,
			compartment,
			NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID,
		);
	});
}

function seedWorld(name: string, hiddenArtifacts: number): number {
	initDbAccessor(join(root, "memory", `${name}.db`));
	const compartment = getSyncDbAccessor().withWriteTx((db) => {
		db.exec(
			"INSERT INTO classifications(id,name) VALUES ('cls_public_ids','Public ids hidden'); INSERT INTO classification_audience VALUES ('cls_public_ids','user','carol')",
		);
		const id = compartmentFor(db, ["cls_public_ids"]);
		if (id === null) throw new Error("Missing fixture compartment");
		ensureCompartmentShards(db, id, 768);
		return id;
	});
	for (let index = 0; index < hiddenArtifacts; index++)
		insertArtifact(`hidden-${index}`, index % 2 === 0 ? "native_memory" : "transcript", compartment);
	insertArtifact("visible", "native_memory", null);
	insertArtifact("visible", "transcript", null);
	return compartment;
}

function appFor(principal: Principal): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		bindPrincipalAccess(principal, {
			agentModel: "single",
			personalAgentsSelfService: true,
			organizationAgentId: "default",
			personalAgentId: null,
			defaultReadAgentId: null,
			agents: [{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null }],
		});
		c.set("organization", await readOrganization());
		c.set("principal", principal);
		c.set("author", { userId: principal.userId, credential: principal.credential.id });
		await next();
	});
	registerMemoryRoutes(app, { fetchEmbedding: async () => null });
	registerHooksRoutes(app);
	return app;
}

function stable(value: unknown): string {
	return JSON.stringify(value, (key, entry) => (key === "timings" || key === "totalMs" ? undefined : entry));
}

async function readJson(response: Response): Promise<unknown> {
	expect(response.status).toBe(200);
	return await response.json();
}

async function observe(principal: Principal) {
	const app = appFor(principal);
	const query = { query: "Zephyr rollout cadence", agentId: "default", limit: 10 };
	const recall = await readJson(
		await app.request("http://signet.test/api/memory/recall", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(query),
		}),
	);
	const search = await readJson(
		await app.request("http://signet.test/api/memory/search?q=Zephyr%20rollout%20cadence&agentId=default&limit=10"),
	);
	const hooks = await readJson(
		await app.request("http://signet.test/api/hooks/recall", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...query, harness: "codex" }),
		}),
	);
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) =>
			await app.request(input instanceof Request ? input : String(input), init),
		{ preconnect: previousFetch.preconnect },
	);
	const server = await createMcpServer({ daemonUrl: "http://signet.test", version: "test", agentId: "default" });
	const client = new Client({ name: "recall-public-ids", version: "1" }, { capabilities: {} });
	try {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const mcp = await client.callTool({ name: "memory_search", arguments: { query: query.query, limit: 10 } });
		return { recall: stable(recall), search: stable(search), hooks: stable(hooks), mcp: JSON.stringify(mcp) };
	} finally {
		await client.close();
		await server.close();
		globalThis.fetch = previousFetch;
	}
}

function resultIds(serialized: string): string[] {
	const parsed: unknown = JSON.parse(serialized);
	if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results))
		return [];
	return parsed.results.flatMap((row: unknown) =>
		typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? [row.id] : [],
	);
}

test("public recall ids and payloads do not change when hidden artifacts precede a visible one", async () => {
	const outsider = readerPrincipal("alice");
	seedWorld("world-empty", 0);
	const empty = await observe(outsider);
	await closeDbAccessor();
	seedWorld("world-hidden", 7);
	const hidden = await observe(outsider);
	await closeDbAccessor();

	const serialized = [empty, hidden].flatMap((surface) => [surface.recall, surface.search, surface.hooks, surface.mcp]);
	const ids = resultIds(empty.recall);
	expect(ids).toContain("transcript:visible-session");
	expect({
		nativeArtifactReturned: ids.some((id) => id.startsWith("native-artifact:")),
		rowidIds: serialized.flatMap((text) => text.match(/native-artifact:\d+(?![0-9a-f])/g) ?? []),
		readProvenance: serialized.filter((text) => text.includes("readProvenance")).length,
		compartmentIds: serialized.filter((text) => text.includes("compartmentIds")).length,
		hiddenPaths: serialized.filter((text) => text.includes("hidden-")).length,
		recallIdentical: hidden.recall === empty.recall,
		searchIdentical: hidden.search === empty.search,
		hooksIdentical: hidden.hooks === empty.hooks,
		mcpIdentical: hidden.mcp === empty.mcp,
	}).toEqual({
		nativeArtifactReturned: true,
		rowidIds: [],
		readProvenance: 0,
		compartmentIds: 0,
		hiddenPaths: 0,
		recallIdentical: true,
		searchIdentical: true,
		hooksIdentical: true,
		mcpIdentical: true,
	});
	expect(hidden.recall).toBe(empty.recall);
}, 60000);

test("telemetry keeps artifact labels for stable and legacy native artifact ids", async () => {
	const compartment = seedWorld("world-telemetry", 3);
	try {
		const audience = await observe(readerPrincipal("carol"));
		const hiddenIds = resultIds(audience.recall).filter((id) => id.startsWith("native-artifact:"));
		expect(hiddenIds.length).toBeGreaterThan(1);
		let labels: readonly (string | null)[] = [];
		for (let attempt = 0; attempt < 50 && labels.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			labels = getSyncDbAccessor().withReadDb((db) =>
				db
					.prepare(
						`SELECT cm.classification_id FROM memory_search_telemetry t
						 LEFT JOIN compartment_members cm ON cm.compartment_id = t.compartment_id
						 WHERE t.route = 'POST /api/memory/recall'`,
					)
					.all()
					.map((row) =>
						typeof row === "object" &&
						row !== null &&
						"classification_id" in row &&
						typeof row.classification_id === "string"
							? row.classification_id
							: null,
					),
			);
		}
		expect(labels).toContain("cls_public_ids");
		const cited = getSyncDbAccessor().withReadDb((db) =>
			db
				.prepare(
					"SELECT evidence_id FROM evidence_citations WHERE derived_kind = 'telemetry' AND evidence_kind = 'artifact' ORDER BY evidence_id",
				)
				.all()
				.map((row) => (typeof row === "object" && row !== null && "evidence_id" in row ? row.evidence_id : null)),
		);
		expect(cited).toContain("hidden-0/native_memory.md");
		const legacy = getSyncDbAccessor().withWriteTx((db) => {
			const row = db
				.prepare("SELECT rowid AS id FROM memory_artifacts WHERE source_path = 'hidden-0/native_memory.md'")
				.get();
			const rowid = typeof row?.id === "number" ? row.id : -1;
			const evidence = telemetryEvidenceInTx(db, {
				agentId: "default",
				sessionKey: null,
				resultIds: [`native-artifact:${rowid}`],
			});
			return evidence.labels.get(`native-artifact:${rowid}`) ?? [];
		});
		expect(legacy).toContain("cls_public_ids");
		expect(compartment).toBeGreaterThan(0);
	} finally {
		await closeDbAccessor();
	}
}, 60000);
