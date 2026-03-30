/**
 * Reactive state for the MCP Servers section.
 * Follows the same $state pattern as skills.svelte.ts.
 */

import {
	getMcpServers,
	getMcpServerTools,
	discoverMcpServers,
	importMcpServer,
	toggleMcpServer,
	removeMcpServer,
	generateMcpCli,
	type McpServer,
	type McpTool,
	type DiscoveredServer,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

export type McpView = "installed" | "discover";

export const mcp = $state({
	view: "installed" as McpView,

	installed: [] as McpServer[],
	loading: false,

	discovered: [] as DiscoveredServer[],
	discoverLoading: false,
	discoverLoaded: false,

	// Tool inspector — lazy loaded per server
	toolsCache: {} as Record<string, McpTool[]>,
	toolsLoading: new Set<string>(),
	expandedId: null as string | null,

	// Per-server action states
	generatingCli: new Set<string>(),
	removing: new Set<string>(),
	toggling: new Set<string>(),
	importing: new Set<string>(),
});

export async function fetchInstalled(): Promise<void> {
	mcp.loading = true;
	mcp.installed = await getMcpServers();
	mcp.loading = false;
}

export async function fetchDiscovered(): Promise<void> {
	mcp.discoverLoading = true;
	mcp.discovered = await discoverMcpServers();
	mcp.discoverLoaded = true;
	mcp.discoverLoading = false;
}

/** Expand a server card — lazily loads its tool list on first expand. */
export async function toggleExpand(id: string): Promise<void> {
	if (mcp.expandedId === id) {
		mcp.expandedId = null;
		return;
	}
	mcp.expandedId = id;
	if (mcp.toolsCache[id] !== undefined || mcp.toolsLoading.has(id)) return;

	mcp.toolsLoading = new Set([...mcp.toolsLoading, id]);
	const tools = await getMcpServerTools(id);
	mcp.toolsCache = { ...mcp.toolsCache, [id]: tools };
	mcp.toolsLoading = new Set([...mcp.toolsLoading].filter((x) => x !== id));
}

export async function doImport(server: DiscoveredServer): Promise<void> {
	mcp.importing = new Set([...mcp.importing, server.name]);
	const result = await importMcpServer(server.name, server.rawConfig);
	if (result.success) {
		toast(`Imported '${server.name}'`, "success");
		await fetchInstalled();
		// Mark as installed in the discover list
		mcp.discovered = mcp.discovered.map((s) =>
			s.name === server.name ? { ...s, alreadyInstalled: true } : s,
		);
	} else {
		toast(result.error ?? `Failed to import '${server.name}'`, "error");
	}
	mcp.importing = new Set([...mcp.importing].filter((x) => x !== server.name));
}

export async function doToggle(id: string, enabled: boolean): Promise<void> {
	mcp.toggling = new Set([...mcp.toggling, id]);
	const updated = await toggleMcpServer(id, enabled);
	if (updated !== null) {
		mcp.installed = mcp.installed.map((s) => (s.id === id ? updated : s));
	} else {
		toast("Failed to update server", "error");
	}
	mcp.toggling = new Set([...mcp.toggling].filter((x) => x !== id));
}

export async function doRemove(id: string, name: string): Promise<void> {
	mcp.removing = new Set([...mcp.removing, id]);
	const ok = await removeMcpServer(id);
	if (ok) {
		toast(`Removed '${name}'`, "success");
		mcp.installed = mcp.installed.filter((s) => s.id !== id);
		if (mcp.expandedId === id) mcp.expandedId = null;
		const updated = { ...mcp.toolsCache };
		delete updated[id];
		mcp.toolsCache = updated;
	} else {
		toast(`Failed to remove '${name}'`, "error");
	}
	mcp.removing = new Set([...mcp.removing].filter((x) => x !== id));
}

export async function doGenerateCli(id: string, name: string): Promise<void> {
	mcp.generatingCli = new Set([...mcp.generatingCli, id]);
	const result = await generateMcpCli(id);
	if (result.success && result.path !== undefined) {
		toast(`CLI generated: ${result.path}`, "success");
		// Refresh to pick up cli_path from DB
		mcp.installed = await getMcpServers();
	} else {
		toast(result.error ?? `CLI generation failed for '${name}'`, "error");
	}
	mcp.generatingCli = new Set([...mcp.generatingCli].filter((x) => x !== id));
}
