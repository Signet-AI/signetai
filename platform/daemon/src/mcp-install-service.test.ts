import { describe, expect, it } from "bun:test";
import type { McpProbeResult } from "@signet/core";
import {
	installMcpServer,
	type InstalledMarketplaceMcpServer,
	type MarketplaceMcpInstallDependencies,
	type MarketplaceMcpProbeOptions,
} from "./mcp-install-service.js";

interface InstallHarness {
	readonly dependencies: MarketplaceMcpInstallDependencies;
	readonly getInstalled: () => readonly InstalledMarketplaceMcpServer[];
	readonly counts: {
		writes: number;
		invalidations: number;
		probes: number;
		stores: number;
	};
}

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

function makeHarness(
	probe?: (server: InstalledMarketplaceMcpServer, options: MarketplaceMcpProbeOptions) => Promise<McpProbeResult>,
	fetchDetail?: MarketplaceMcpInstallDependencies["fetchDetail"],
): InstallHarness {
	let installed: InstalledMarketplaceMcpServer[] = [];
	let storedProbe: McpProbeResult | null = null;
	const counts = { writes: 0, invalidations: 0, probes: 0, stores: 0 };
	const dependencies: MarketplaceMcpInstallDependencies = {
		readInstalledServers: () => installed,
		writeInstalledServers: (servers) => {
			counts.writes++;
			installed = [...servers];
		},
		fetchDetail:
			fetchDetail ??
			(async () => ({
				nameHint: "Catalog Server",
				description: "A catalog test server",
				config: {
					transport: "http",
					url: "https://catalog.example.test/mcp",
					headers: {},
					timeoutMs: 20_000,
				},
			})),
		invalidateToolsCache: () => {
			counts.invalidations++;
		},
		probeServer: async (server, options) => {
			counts.probes++;
			if (probe) return probe(server, options);
			return makeProbe(server.id);
		},
		storeProbeResult: (result) => {
			counts.stores++;
			storedProbe = result;
		},
		loadProbeResult: () => storedProbe,
	};
	return { dependencies, getInstalled: () => installed, counts };
}

describe("installMcpServer", () => {
	it("does not mutate after a catalog deadline expires before preparation completes", async () => {
		let releaseDetail: (() => void) | undefined;
		let detailSignal: AbortSignal | undefined;
		const detail = new Promise<void>((resolve) => {
			releaseDetail = resolve;
		});
		const harness = makeHarness(undefined, async (_source, _catalogId, options) => {
			detailSignal = options.signal;
			await detail;
			return {
				nameHint: "Late Catalog Server",
				description: "Late detail",
				config: {
					transport: "http",
					url: "https://catalog.example.test/late",
					headers: {},
					timeoutMs: 20_000,
				},
			};
		});

		const install = installMcpServer(
			{ kind: "catalog", source: "mcpservers.org", catalogId: "late-server" },
			{ timeoutMs: 40 },
			harness.dependencies,
		);
		const rejected = expect(install).rejects.toMatchObject({ code: "timeout" });
		await Bun.sleep(100);
		releaseDetail?.();

		await rejected;
		expect(detailSignal?.aborted).toBe(true);
		expect(harness.counts.writes).toBe(0);
		expect(harness.getInstalled()).toHaveLength(0);
	});

	it("returns an accepted operation when the deadline expires after mutation", async () => {
		const harness = makeHarness(async () => {
			await Bun.sleep(150);
			return makeProbe("slow-server");
		});

		const result = await installMcpServer(
			{ kind: "direct", url: "https://slow.example.test/mcp", name: "Slow Server" },
			{ timeoutMs: 100 },
			harness.dependencies,
		);

		expect(result.status).toBe("accepted");
		expect(result.operationId).toMatch(/^mcp-install-/);
		expect(result.created).toBe(true);
		expect(harness.counts.writes).toBe(1);
		expect(harness.counts.stores).toBe(0);
	});

	it("coalesces concurrent retries and probes an install only once", async () => {
		const harness = makeHarness(async (server) => {
			await Bun.sleep(15);
			return makeProbe(server.id);
		});
		const request = { kind: "direct" as const, url: "https://retry.example.test/mcp", name: "Retry Server" };

		const [first, second] = await Promise.all([
			installMcpServer(request, { idempotencyKey: "retry-key" }, harness.dependencies),
			installMcpServer(request, { idempotencyKey: "retry-key" }, harness.dependencies),
		]);
		const retry = await installMcpServer(request, { idempotencyKey: "retry-key" }, harness.dependencies);

		expect(first.operationId).toBe(second.operationId);
		expect(retry.operationId).toBe(first.operationId);
		expect(retry.mutation).toBe("unchanged");
		expect(harness.counts.writes).toBe(1);
		expect(harness.counts.probes).toBe(1);
		expect(harness.counts.stores).toBe(1);
	});

	it("uses the same mutation, cache, and probe boundary for direct and catalog installs", async () => {
		const harness = makeHarness();

		const direct = await installMcpServer(
			{ kind: "direct", url: "https://direct.example.test/mcp" },
			{},
			harness.dependencies,
		);
		const catalog = await installMcpServer(
			{
				kind: "catalog",
				source: "mcpservers.org",
				catalogId: "catalog-server",
				config: {
					transport: "http",
					url: "https://catalog.example.test/mcp",
				},
			},
			{},
			harness.dependencies,
		);

		expect(direct.status).toBe("completed");
		expect(catalog.status).toBe("completed");
		expect(harness.counts.writes).toBe(2);
		expect(harness.counts.invalidations).toBe(2);
		expect(harness.counts.probes).toBe(2);
		expect(harness.counts.stores).toBe(2);
	});
});
