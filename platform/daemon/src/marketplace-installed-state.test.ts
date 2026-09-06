import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountAppTrayRoutes } from "./routes/app-tray.js";
import { mountMarketplaceRoutes } from "./routes/marketplace.js";
import {
	getInstalledMcpPath,
	InstalledServerStateError,
	readInstalledServers,
	readInstalledServersWithDiagnostics,
	writeInstalledServers,
} from "./marketplace-installed-state.js";

function validServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "valid-server",
		source: "manual",
		name: "Valid Server",
		description: "A valid test server",
		category: "Test",
		official: false,
		enabled: true,
		scope: { harnesses: [], workspaces: [], channels: [] },
		config: {
			transport: "http",
			url: "https://example.com/mcp",
			headers: {},
			timeoutMs: 5_000,
		},
		installedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("installed MCP server state", () => {
	let agentsDir: string;
	let previousSignetPath: string | undefined;

	beforeEach(() => {
		previousSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-installed-mcp-state-"));
		mkdirSync(join(agentsDir, "marketplace"), { recursive: true });
		process.env.SIGNET_PATH = agentsDir;
	});

	afterEach(() => {
		if (previousSignetPath === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previousSignetPath;
		if (existsSync(agentsDir)) rmSync(agentsDir, { recursive: true, force: true });
	});

	it("quarantines malformed rows while exposing one canonical active set", () => {
		const rows = [
			validServer(),
			{
				id: "missing-config",
				source: "manual",
				name: "Missing Config",
				description: "bad",
				category: "Test",
				official: false,
				enabled: true,
				installedAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			validServer({ id: "bad-scope", scope: { harnesses: "not-an-array", workspaces: [], channels: [] } }),
			validServer({ id: "bad-time", updatedAt: "not-a-timestamp" }),
			validServer({ id: "bad-source", source: "unknown" }),
			validServer({ id: "bad-transport", config: { transport: "websocket", url: "https://example.com/mcp" } }),
		];
		writeFileSync(getInstalledMcpPath(), JSON.stringify(rows));

		const result = readInstalledServersWithDiagnostics();

		expect(result.readable).toBe(true);
		expect(result.servers.map((server) => server.id)).toEqual(["valid-server"]);
		expect(result.invalidEntries.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5]);
		expect(readInstalledServers().map((server) => server.id)).toEqual(["valid-server"]);
	});

	it("keeps malformed state out of marketplace and probe consumers", async () => {
		writeFileSync(
			getInstalledMcpPath(),
			JSON.stringify([{ id: "broken", source: "manual", name: "Broken", enabled: true }]),
		);
		const app = new Hono();
		mountMarketplaceRoutes(app);
		mountAppTrayRoutes(app);

		const marketplaceResponse = await app.request("/api/marketplace/mcp");
		const marketplaceBody = (await marketplaceResponse.json()) as { servers: unknown[] };
		expect(marketplaceBody.servers).toEqual([]);

		const trayResponse = await app.request("/api/os/tray");
		const trayBody = (await trayResponse.json()) as { entries: unknown[] };
		expect(trayBody.entries).toEqual([]);

		const reprobeResponse = await app.request("/api/os/tray/broken/reprobe", { method: "POST" });
		expect(reprobeResponse.status).toBe(404);
	});

	it("normalizes legacy command-array state before consumers receive it", () => {
		const legacy = validServer({
			config: {
				command: ["node", "server.js"],
				args: ["--port", "3000"],
				env: { NODE_ENV: "test" },
			},
		});
		delete legacy.scope;
		writeFileSync(getInstalledMcpPath(), JSON.stringify([legacy]));

		const [server] = readInstalledServers();

		expect(server).toMatchObject({
			id: "valid-server",
			scope: { harnesses: [], workspaces: [], channels: [] },
			config: {
				transport: "stdio",
				command: "node",
				args: ["server.js", "--port", "3000"],
				timeoutMs: 20_000,
			},
		});
		if (!server) throw new Error("legacy fixture was rejected");
		writeInstalledServers([server]);
		expect(readInstalledServers()[0]?.config.transport).toBe("stdio");
	});

	it("atomically validates mutations and never overwrites unreadable state", () => {
		const initial = validServer();
		writeInstalledServers([initial]);
		const path = getInstalledMcpPath();
		const beforeInvalidWrite = readFileSync(path, "utf8");

		expect(() =>
			writeInstalledServers([
				validServer({
					config: { transport: "stdio", command: 42 },
				}),
			]),
		).toThrow(InstalledServerStateError);
		expect(readFileSync(path, "utf8")).toBe(beforeInvalidWrite);
		expect(readdirSync(join(agentsDir, "marketplace")).filter((name) => name.includes(".tmp-")).length).toBe(0);

		writeFileSync(path, "{not-json");
		expect(() => writeInstalledServers([])).toThrow(InstalledServerStateError);
		expect(readFileSync(path, "utf8")).toBe("{not-json");
	});

	it("drops rejected rows when a valid read-modify-write succeeds", () => {
		const path = getInstalledMcpPath();
		writeFileSync(path, JSON.stringify([validServer(), validServer({ id: "bad", config: null })]));

		writeInstalledServers(readInstalledServers());

		expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
		expect(readInstalledServersWithDiagnostics().invalidEntries).toEqual([]);
	});
});
