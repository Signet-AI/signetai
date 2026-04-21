// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { mergePluginRecord } from "./plugin-record";

const base = {
	id: "signet.secrets",
	name: "Signet Secrets",
	version: "1.0.0",
	publisher: "signet",
	source: "bundled",
	trustTier: "core",
	enabled: true,
	state: "active",
	declaredCapabilities: ["secrets:list"],
	grantedCapabilities: ["secrets:list"],
	pendingCapabilities: [],
	surfaces: {
		daemonRoutes: [],
		cliCommands: [{ path: ["secret", "list"], summary: "List secrets", requiredCapabilities: ["secrets:list"] }],
		mcpTools: [],
		dashboardPanels: [],
		sdkClients: [],
		connectorCapabilities: [],
		promptContributions: [],
	},
	installedAt: "2026-04-17T00:00:00.000Z",
	updatedAt: "2026-04-17T00:00:00.000Z",
};

describe("plugin record merging", () => {
	it("preserves existing required fields when toggle responses are partial", () => {
		const merged = mergePluginRecord(base, { id: "signet.secrets", enabled: false });

		expect(merged.enabled).toBe(false);
		expect(merged.name).toBe("Signet Secrets");
		expect(merged.surfaces.cliCommands).toHaveLength(1);
	});

	it("ignores updates for a different plugin id", () => {
		expect(mergePluginRecord(base, { id: "other.plugin", enabled: false })).toBe(base);
	});
});
