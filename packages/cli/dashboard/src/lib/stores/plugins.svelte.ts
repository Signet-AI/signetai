import {
	type PluginAuditEvent,
	type PluginDiagnostics,
	type PluginRegistryRecord,
	getPluginDiagnostics,
	listPluginAuditEvents,
	listPlugins,
	setPluginEnabled,
} from "$lib/api";
import { createLatestRequestGate } from "$lib/stores/latest-request";
import { mergePluginRecord } from "$lib/stores/plugin-record";
import { toast } from "$lib/stores/toast.svelte";

const AUDIT_LIMIT = 50;
export const SIGNET_SECRETS_PLUGIN_ID = "signet.secrets";

const diagnosticsRequests = createLatestRequestGate();
const auditRequests = createLatestRequestGate();

export const pluginsStore = $state({
	plugins: [] as PluginRegistryRecord[],
	selectedId: null as string | null,
	diagnostics: null as PluginDiagnostics | null,
	diagnosticsPluginId: null as string | null,
	auditEvents: [] as PluginAuditEvent[],
	auditPluginId: null as string | null,
	loading: false,
	diagnosticsLoading: false,
	auditLoading: false,
	togglingId: null as string | null,
	error: null as string | null,
	diagnosticsError: null as string | null,
	auditError: null as string | null,
});

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

export function getSelectedPlugin(): PluginRegistryRecord | null {
	if (!pluginsStore.selectedId) return pluginsStore.plugins[0] ?? null;
	return (
		pluginsStore.plugins.find((plugin) => plugin.id === pluginsStore.selectedId) ?? pluginsStore.plugins[0] ?? null
	);
}

export function countPluginSurfaces(plugin: PluginRegistryRecord): number {
	return (
		plugin.surfaces.daemonRoutes.length +
		plugin.surfaces.cliCommands.length +
		plugin.surfaces.mcpTools.length +
		plugin.surfaces.dashboardPanels.length +
		plugin.surfaces.sdkClients.length +
		plugin.surfaces.connectorCapabilities.length +
		plugin.surfaces.promptContributions.length
	);
}

export function formatPluginState(plugin: PluginRegistryRecord): string {
	if (!plugin.enabled) return "disabled";
	if (plugin.health?.status === "unhealthy") return "unhealthy";
	if (plugin.health?.status === "degraded" || plugin.state === "degraded") return "degraded";
	return plugin.state;
}

export async function loadPlugins(): Promise<void> {
	pluginsStore.loading = true;
	pluginsStore.error = null;
	try {
		const data = await listPlugins();
		pluginsStore.plugins = [...data.plugins].sort((a, b) => {
			if (a.trustTier === "core" && b.trustTier !== "core") return -1;
			if (a.trustTier !== "core" && b.trustTier === "core") return 1;
			return a.name.localeCompare(b.name);
		});
		if (!pluginsStore.selectedId || !pluginsStore.plugins.some((plugin) => plugin.id === pluginsStore.selectedId)) {
			pluginsStore.selectedId = pluginsStore.plugins[0]?.id ?? null;
		}
	} catch (error) {
		pluginsStore.plugins = [];
		pluginsStore.selectedId = null;
		pluginsStore.error = toErrorMessage(error);
	} finally {
		pluginsStore.loading = false;
	}
}

export async function selectPlugin(id: string): Promise<void> {
	pluginsStore.selectedId = id;
	await Promise.all([loadPluginDiagnostics(id), loadPluginAuditEvents(id)]);
}

export async function loadSelectedPluginDetails(): Promise<void> {
	const selected = getSelectedPlugin();
	if (!selected) return;
	await Promise.all([loadPluginDiagnostics(selected.id), loadPluginAuditEvents(selected.id)]);
}

export async function loadPluginDiagnostics(id: string): Promise<void> {
	const requestId = diagnosticsRequests.next();
	pluginsStore.diagnosticsPluginId = id;
	pluginsStore.diagnosticsLoading = true;
	pluginsStore.diagnosticsError = null;
	try {
		const data = await getPluginDiagnostics(id);
		if (!diagnosticsRequests.isCurrent(requestId)) return;
		pluginsStore.diagnostics = data.plugin;
	} catch (error) {
		if (!diagnosticsRequests.isCurrent(requestId)) return;
		pluginsStore.diagnostics = null;
		pluginsStore.diagnosticsError = toErrorMessage(error);
	} finally {
		if (diagnosticsRequests.isCurrent(requestId)) {
			pluginsStore.diagnosticsLoading = false;
		}
	}
}

export async function loadPluginAuditEvents(id: string): Promise<void> {
	const requestId = auditRequests.next();
	if (pluginsStore.auditPluginId !== id) {
		pluginsStore.auditEvents = [];
	}
	pluginsStore.auditPluginId = id;
	pluginsStore.auditLoading = true;
	pluginsStore.auditError = null;
	try {
		const data = await listPluginAuditEvents({ pluginId: id, limit: AUDIT_LIMIT });
		if (!auditRequests.isCurrent(requestId)) return;
		pluginsStore.auditEvents = [...data.events];
	} catch (error) {
		if (!auditRequests.isCurrent(requestId)) return;
		pluginsStore.auditEvents = [];
		pluginsStore.auditError = toErrorMessage(error);
	} finally {
		if (auditRequests.isCurrent(requestId)) {
			pluginsStore.auditLoading = false;
		}
	}
}

export async function togglePlugin(id: string, enabled: boolean): Promise<void> {
	pluginsStore.togglingId = id;
	try {
		const data = await setPluginEnabled(id, enabled);
		const existing = pluginsStore.plugins.find((plugin) => plugin.id === id);
		const updated = existing ? mergePluginRecord(existing, data.plugin) : data.plugin;
		pluginsStore.plugins = pluginsStore.plugins.map((plugin) => (plugin.id === id ? updated : plugin));
		await Promise.all([loadPluginDiagnostics(id), loadPluginAuditEvents(id)]);
		toast(`${updated.name} ${enabled ? "enabled" : "disabled"}`, "success");
	} catch (error) {
		toast(toErrorMessage(error), "error");
	} finally {
		pluginsStore.togglingId = null;
	}
}
