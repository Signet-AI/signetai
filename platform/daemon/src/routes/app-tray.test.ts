import { describe, expect, it } from "bun:test";
import type { McpProbeResult } from "@signet/core";
import { Hono } from "hono";
import { mountAppTrayRoutes } from "./app-tray.js";
import type {
	InstalledMarketplaceMcpServer,
	MarketplaceMcpInstallDependencies,
	MarketplaceMcpProbeOptions,
} from "../mcp-install-service.js";

function makeProbe(serverId: string): McpProbeResult {
	return {
		serverId,
		ok: true,
		autoCard: {
			name: serverId,
			tools: [],
			resources: [],
			hasAppResources: false,
			defaultSize: { w: 4, h: 3 },
		},
		toolCount: 0,
		resourceCount: 0,
		hasAppResources: false,
		probedAt: new Date().toISOString(),
	};
}

describe("app-tray install route", () => {
	it("shares one idempotent install and probe for concurrent requests", async () => {
		let installed: InstalledMarketplaceMcpServer[] = [];
		let probes = 0;
		let stores = 0;
		const dependencies: MarketplaceMcpInstallDependencies = {
			readInstalledServers: () => installed,
			writeInstalledServers: (servers) => {
				installed = [...servers];
			},
			invalidateToolsCache: () => undefined,
			probeServer: async (server, _options: MarketplaceMcpProbeOptions) => {
				probes++;
				await Bun.sleep(15);
				return makeProbe(server.id);
			},
			storeProbeResult: () => {
				stores++;
			},
			loadProbeResult: () => null,
		};
		const app = new Hono();
		mountAppTrayRoutes(app, dependencies);
		const init: RequestInit = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://route-retry.example.test/mcp", name: "Route Retry" }),
		};

		const [first, second] = await Promise.all([
			app.request("/api/os/install", init),
			app.request("/api/os/install", init),
		]);
		const firstBody = (await first.json()) as {
			status: string;
			widgetId: string;
			operationId: string;
			created: boolean;
		};
		const secondBody = (await second.json()) as { operationId: string };

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(firstBody.status).toBe("completed");
		expect(firstBody.created).toBe(true);
		expect(firstBody.widgetId).toBe("route-retry");
		expect(secondBody.operationId).toBe(firstBody.operationId);
		expect(installed).toHaveLength(1);
		expect(probes).toBe(1);
		expect(stores).toBe(1);
	});
});
