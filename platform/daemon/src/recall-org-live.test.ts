import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OrgDaemon } from "../../../tests/integration/org-mode/daemon";
import { browser, record, request, success, text } from "../../../tests/integration/org-mode/http";
import { createMcpServer } from "./mcp/tools";

function stableRecall(value: unknown) {
	const body = record(value);
	const meta = record(body.meta);
	return JSON.stringify({ ...body, meta: { ...meta, timings: undefined } });
}

test("a real organization daemon scopes HTTP and MCP recall before ranking", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await daemon.setupToken(),
			organizationName: "Recall isolation fixture",
			admin: { username: "recall-admin", displayName: "Recall Admin", password: "synthetic-recall-test-password" },
		});
		const claimed = success(claim, "claim isolated recall organization");
		const sessionCookie = browser(claim)
			.cookie?.split("; ")
			.find((value) => value.startsWith("signet_session="));
		const credential = { bearer: text(sessionCookie?.slice("signet_session=".length)) };
		const userId = text(record(claimed.user).id);
		success(
			await request(daemon.origin, `/api/org/users/${userId}`, credential, "PATCH", { compliance: true }),
			"grant fixture classification authority",
		);
		success(
			await request(daemon.origin, "/api/org/settings", credential, "PATCH", { agentModel: "single" }),
			"select single-agent fixture",
		);
		const publicText = "Atlas deployment public canary pipeline";
		const publicMemory = success(
			await request(daemon.origin, "/api/memory/remember", credential, "POST", {
				content: publicText,
				agentId: "default",
			}),
			"remember public fixture",
		);
		const recallBody = { query: "Atlas deployment", agentId: "default", limit: 10, trackRecallAccess: false };
		const before = success(
			await request(daemon.origin, "/api/memory/recall", credential, "POST", recallBody),
			"recall baseline",
		);
		expect(JSON.stringify(before)).toContain(text(publicMemory.id));
		const secretText = "Atlas deployment SYNTHETIC_HIDDEN_HR canary pipeline";
		const hidden = success(
			await request(daemon.origin, "/api/memory/remember", credential, "POST", {
				content: secretText,
				agentId: "default",
			}),
			"remember classified fixture",
		);
		const classification = success(
			await request(daemon.origin, "/api/classifications", credential, "POST", {
				name: "Recall fixture secret",
				audience: [],
			}),
			"create fixture classification",
		);
		const classificationId = text(classification.id);
		success(
			await request(daemon.origin, `/api/classifications/${classificationId}/apply?wait=1`, credential, "POST", {
				target: { kind: "memory", id: text(hidden.id), agentId: "default" },
			}),
			"classify fixture memory",
		);
		const after = success(
			await request(daemon.origin, "/api/memory/recall", credential, "POST", {
				...recallBody,
				readScope: { reach: { kind: "all" }, compartments: "all", projects: null },
			}),
			"recall after hidden insertion",
		);
		expect(stableRecall(after)).toBe(stableRecall(before));
		const server = await createMcpServer({
			daemonUrl: daemon.origin,
			version: "test",
			authorizationHeader: `Bearer ${credential.bearer}`,
		});
		const client = new Client({ name: "recall-isolation-test", version: "1" }, { capabilities: {} });
		try {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			const result = await client.callTool({
				name: "memory_search",
				arguments: { query: "Atlas deployment", limit: 10 },
			});
			expect(result.isError).not.toBe(true);
			expect(JSON.stringify(result)).toContain(publicText);
			expect(JSON.stringify(result)).not.toContain("SYNTHETIC_HIDDEN_HR");
		} finally {
			await client.close();
			await server.close();
		}
		success(
			await request(daemon.origin, `/api/classifications/${classificationId}/audience`, credential, "PUT", [
				{ kind: "user", id: userId },
			]),
			"grant fixture audience membership",
		);
		const audience = success(
			await request(daemon.origin, "/api/memory/recall", credential, "POST", recallBody),
			"recall as audience member",
		);
		expect(JSON.stringify(audience)).toContain("SYNTHETIC_HIDDEN_HR");
	} finally {
		await daemon.dispose();
		expect(daemon.child).toBeUndefined();
		expect(daemon.lastStoppedPids.length).toBeGreaterThan(1);
	}
}, 120000);
