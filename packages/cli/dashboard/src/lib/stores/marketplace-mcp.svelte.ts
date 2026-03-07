import {
	type MarketplaceMcpCatalogEntry,
	type MarketplaceMcpConfig,
	type MarketplaceMcpServer,
	type MarketplaceMcpServerHealth,
	type MarketplaceMcpTool,
	browseMarketplaceMcpServers,
	deleteMarketplaceMcpServer,
	getMarketplaceMcpServers,
	getMarketplaceMcpTools,
	installMarketplaceMcpServer,
	updateMarketplaceMcpServer,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

export type McpCatalogSort = "popularity" | "name" | "official";
export type McpCatalogSourceFilter = "all" | "mcpservers.org" | "modelcontextprotocol/servers";
export type McpMarketView = "browse" | "installed";

export const mcpMarket = $state({
	installed: [] as MarketplaceMcpServer[],
	loadingInstalled: false,

	catalog: [] as MarketplaceMcpCatalogEntry[],
	catalogTotal: 0,
	catalogLoaded: false,
	catalogLoading: false,
	catalogDetail: false,

	query: "",
	view: "browse" as McpMarketView,
	category: "all",
	source: "all" as McpCatalogSourceFilter,
	sortBy: "popularity" as McpCatalogSort,

	tools: [] as MarketplaceMcpTool[],
	serverHealth: [] as MarketplaceMcpServerHealth[],
	toolsLoading: false,

	installingId: null as string | null,
	togglingId: null as string | null,
	removingId: null as string | null,

	installedError: null as string | null,
	catalogError: null as string | null,
	toolsError: null as string | null,
});

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}

function sortCatalog(
	entries: readonly MarketplaceMcpCatalogEntry[],
	sortBy: McpCatalogSort,
): MarketplaceMcpCatalogEntry[] {
	const items = [...entries];
	switch (sortBy) {
		case "name":
			return items.sort((a, b) => a.name.localeCompare(b.name));
		case "official":
			return items.sort((a, b) => {
				if (a.official && !b.official) return -1;
				if (!a.official && b.official) return 1;
				return a.popularityRank - b.popularityRank;
			});
		default:
			return items.sort((a, b) => a.popularityRank - b.popularityRank);
	}
}

function filterCatalog(entries: readonly MarketplaceMcpCatalogEntry[]): MarketplaceMcpCatalogEntry[] {
	const q = mcpMarket.query.trim().toLowerCase();
	return entries.filter((entry) => {
		if (mcpMarket.category !== "all" && entry.category !== mcpMarket.category) {
			return false;
		}
		if (mcpMarket.source !== "all" && entry.source !== mcpMarket.source) {
			return false;
		}
		if (!q) return true;
		return (
			entry.name.toLowerCase().includes(q) ||
			entry.description.toLowerCase().includes(q) ||
			entry.id.toLowerCase().includes(q)
		);
	});
}

export function getMarketplaceMcpCategoryOptions(): string[] {
	const set = new Set<string>(["all"]);
	for (const entry of mcpMarket.catalog) {
		set.add(entry.category);
	}
	return Array.from(set);
}

export function getMarketplaceMcpSourceOptions(): McpCatalogSourceFilter[] {
	return ["all", "mcpservers.org", "modelcontextprotocol/servers"];
}

export function getFilteredMarketplaceMcpCatalog(): MarketplaceMcpCatalogEntry[] {
	return sortCatalog(filterCatalog(mcpMarket.catalog), mcpMarket.sortBy);
}

export async function fetchMarketplaceMcpInstalled(): Promise<void> {
	mcpMarket.loadingInstalled = true;
	mcpMarket.installedError = null;
	try {
		const data = await getMarketplaceMcpServers();
		mcpMarket.installed = data.servers;
	} catch (error) {
		mcpMarket.installed = [];
		mcpMarket.installedError = toErrorMessage(error);
	} finally {
		mcpMarket.loadingInstalled = false;
	}
}

export async function fetchMarketplaceMcpCatalog(pages = 5): Promise<void> {
	if (mcpMarket.catalogLoaded) return;
	mcpMarket.catalogLoading = true;
	mcpMarket.catalogError = null;
	try {
		const data = await browseMarketplaceMcpServers(pages);
		mcpMarket.catalog = data.results;
		mcpMarket.catalogTotal = data.total;
		mcpMarket.catalogLoaded = true;
	} catch (error) {
		mcpMarket.catalogError = toErrorMessage(error);
	} finally {
		mcpMarket.catalogLoading = false;
	}
}

export async function refreshMarketplaceMcpTools(refresh = false): Promise<void> {
	mcpMarket.toolsLoading = true;
	mcpMarket.toolsError = null;
	try {
		const data = await getMarketplaceMcpTools(refresh);
		mcpMarket.tools = data.tools;
		mcpMarket.serverHealth = data.servers;
	} catch (error) {
		mcpMarket.tools = [];
		mcpMarket.serverHealth = [];
		mcpMarket.toolsError = toErrorMessage(error);
	} finally {
		mcpMarket.toolsLoading = false;
	}
}

export async function installMarketplaceCatalogServer(
	entry: MarketplaceMcpCatalogEntry,
	options?: { readonly alias?: string; readonly config?: MarketplaceMcpConfig },
): Promise<boolean> {
	mcpMarket.installingId = entry.id;
	try {
		const result = await installMarketplaceMcpServer({
			id: entry.catalogId,
			source: entry.source,
			alias: options?.alias,
			config: options?.config,
		});
		if (result.success) {
			toast("Tool Server installed", "success");
			await Promise.all([fetchMarketplaceMcpInstalled(), refreshMarketplaceMcpTools(true)]);
			mcpMarket.catalog = mcpMarket.catalog.map((item) => (item.id === entry.id ? { ...item, installed: true } : item));
			return true;
		}

		toast(result.error ?? "Install failed", "error");
		return false;
	} catch (error) {
		toast(toErrorMessage(error), "error");
		return false;
	} finally {
		mcpMarket.installingId = null;
	}
}

export async function toggleMarketplaceMcpServer(id: string, enabled: boolean): Promise<void> {
	mcpMarket.togglingId = id;
	try {
		const result = await updateMarketplaceMcpServer(id, { enabled });
		if (result.success) {
			mcpMarket.installed = mcpMarket.installed.map((server) => (server.id === id ? { ...server, enabled } : server));
			await refreshMarketplaceMcpTools(true);
		} else {
			toast(result.error ?? "Update failed", "error");
		}
	} catch (error) {
		toast(toErrorMessage(error), "error");
	} finally {
		mcpMarket.togglingId = null;
	}
}

export async function removeMarketplaceMcpServer(id: string): Promise<void> {
	mcpMarket.removingId = id;
	try {
		const removed = mcpMarket.installed.find((server) => server.id === id);
		const result = await deleteMarketplaceMcpServer(id);
		if (result.success) {
			toast("Tool Server removed", "success");
			mcpMarket.installed = mcpMarket.installed.filter((s) => s.id !== id);
			await refreshMarketplaceMcpTools(true);
			const removedCatalogKey =
				removed?.catalogId && removed.source !== "manual" ? `${removed.source}:${removed.catalogId}` : null;
			if (removedCatalogKey) {
				mcpMarket.catalog = mcpMarket.catalog.map((entry) =>
					entry.id === removedCatalogKey ? { ...entry, installed: false } : entry,
				);
			}
		} else {
			toast(result.error ?? "Remove failed", "error");
		}
	} catch (error) {
		toast(toErrorMessage(error), "error");
	} finally {
		mcpMarket.removingId = null;
	}
}
