// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { getPluginDiagnostics, listPluginAuditEvents, listPlugins, setPluginEnabled } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("plugin api helpers", () => {
	it("lists plugins from the registry endpoint", async () => {
		globalThis.fetch = async (input) => {
			expect(String(input).endsWith("/api/plugins")).toBe(true);
			return json({
				plugins: [
					{
						id: "signet.secrets",
						name: "Signet Secrets",
						version: "1.0.0",
						publisher: "Signet",
						source: "bundled",
						trustTier: "core",
						enabled: true,
						state: "active",
						declaredCapabilities: ["secrets.read"],
						grantedCapabilities: [],
						pendingCapabilities: [],
						surfaces: {
							daemonRoutes: [],
							cliCommands: [],
							mcpTools: [],
							dashboardPanels: [],
							sdkClients: [],
							connectorCapabilities: [],
							promptContributions: [],
						},
						installedAt: "2026-04-17T00:00:00.000Z",
						updatedAt: "2026-04-17T00:00:00.000Z",
					},
				],
			});
		};

		const res = await listPlugins();

		expect(res.plugins).toHaveLength(1);
		expect(res.plugins[0].grantedCapabilities).toEqual([]);
	});

	it("fetches plugin diagnostics by id", async () => {
		globalThis.fetch = async (input) => {
			expect(String(input).endsWith("/api/plugins/signet.secrets/diagnostics")).toBe(true);
			return json({ plugin: { validationErrors: [], promptContributionDiagnostics: [] } });
		};

		const res = await getPluginDiagnostics("signet.secrets");

		expect(res.plugin.validationErrors).toEqual([]);
	});

	it("queries audit events with plugin id and limit", async () => {
		globalThis.fetch = async (input) => {
			const url = String(input);
			expect(url.endsWith("/api/plugins/audit?pluginId=signet.secrets&limit=50")).toBe(true);
			return json({
				events: [
					{
						id: "audit-1",
						timestamp: "2026-04-17T00:00:00.000Z",
						event: "plugin.enabled",
						pluginId: "signet.secrets",
						result: "ok",
						source: "plugin-host",
						data: {},
					},
				],
				count: 1,
			});
		};

		const res = await listPluginAuditEvents({ pluginId: "signet.secrets", limit: 50 });

		expect(res.count).toBe(1);
		expect(res.events[0].timestamp).toBe("2026-04-17T00:00:00.000Z");
	});

	it("patches plugin enabled state", async () => {
		globalThis.fetch = async (input, init) => {
			expect(String(input).endsWith("/api/plugins/signet.secrets")).toBe(true);
			expect(init?.method).toBe("PATCH");
			expect(init?.headers).toEqual({ "Content-Type": "application/json" });
			expect(JSON.parse(String(init?.body))).toEqual({ enabled: false });
			return json({ plugin: { id: "signet.secrets", enabled: false } });
		};

		const res = await setPluginEnabled("signet.secrets", false);

		expect(res.plugin.enabled).toBe(false);
	});
});
