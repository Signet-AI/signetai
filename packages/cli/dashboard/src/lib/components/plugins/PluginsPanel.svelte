<script lang="ts">
import type {
	PluginCommandSummary,
	PluginConnectorSummary,
	PluginDashboardSummary,
	PluginPromptContributionDiagnostic,
	PluginPromptSummary,
	PluginRegistryRecord,
	PluginRouteSummary,
	PluginSdkSummary,
	PluginToolSummary,
} from "$lib/api";
import {
	type GraphiqStatus,
	installGraphiq as apiInstallGraphiq,
	uninstallGraphiq as apiUninstallGraphiq,
	updateGraphiq as apiUpdateGraphiq,
	getGraphiqStatus,
	indexProjectWithGraphiq,
} from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import { clampPage } from "$lib/stores/plugin-pagination";
import {
	SIGNET_SECRETS_PLUGIN_ID,
	formatPluginState,
	getSelectedPlugin,
	loadPluginAuditEvents,
	loadPluginDiagnostics,
	loadPlugins,
	loadSelectedPluginDetails,
	pluginsStore,
	selectPlugin,
	togglePlugin,
} from "$lib/stores/plugins.svelte";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import { onMount } from "svelte";

const SIGNET_GRAPHIQ_PLUGIN_ID = "signet.graphiq";

const ACTIVITY_PAGE_SIZE = 5;

type Drawer = "permissions" | "activity" | "advanced";

let activityPage = $state(0);
let openDrawer = $state<Drawer | null>(null);

let graphiqStatus = $state<GraphiqStatus | null>(null);
let graphiqLoading = $state(false);
let graphiqAction = $state("");
let graphiqError = $state("");
let indexProjectPath = $state("");

const selected = $derived(getSelectedPlugin());
const isGraphiqSelected = $derived(selected?.id === SIGNET_GRAPHIQ_PLUGIN_ID);
const selectedDiagnostics = $derived(
	pluginsStore.diagnosticsPluginId === selected?.id && pluginsStore.diagnostics?.record.id === selected?.id
		? pluginsStore.diagnostics
		: null,
);
const selectedAuditEvents = $derived(pluginsStore.auditPluginId === selected?.id ? pluginsStore.auditEvents : []);
const lastAuditEvent = $derived(selectedAuditEvents[0] ?? null);
const activityPageCount = $derived(Math.max(1, Math.ceil(selectedAuditEvents.length / ACTIVITY_PAGE_SIZE)));
const activityStart = $derived(activityPage * ACTIVITY_PAGE_SIZE);
const activityItems = $derived(selectedAuditEvents.slice(activityStart, activityStart + ACTIVITY_PAGE_SIZE));

$effect(() => {
	const page = clampPage(activityPage, selectedAuditEvents.length, ACTIVITY_PAGE_SIZE);
	if (page !== activityPage) {
		activityPage = page;
	}
});

$effect(() => {
	if (isGraphiqSelected && !graphiqStatus && !graphiqLoading && !graphiqError) {
		void loadGraphiqStatus();
	}
});

onMount(() => {
	void loadPlugins().then(() => loadSelectedPluginDetails());
});

function formatDate(value: string | null | undefined): string {
	if (!value) return "Unknown";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function pluginDescription(plugin: PluginRegistryRecord): string {
	return selectedDiagnostics?.manifest.description ?? `${plugin.name} adds capabilities to Signet.`;
}

function commandPath(command: PluginCommandSummary): string {
	return command.path.join(" ");
}

function routeLabel(route: PluginRouteSummary): string {
	return `${route.method} ${route.path}`;
}

function toolLabel(tool: PluginToolSummary): string {
	return `${tool.title} (${tool.name})`;
}

function dashboardLabel(panel: PluginDashboardSummary): string {
	return `${panel.title} (${panel.id})`;
}

function sdkLabel(client: PluginSdkSummary): string {
	return client.name;
}

function connectorLabel(connector: PluginConnectorSummary): string {
	return `${connector.title} (${connector.id})`;
}

function promptLabel(prompt: PluginPromptSummary): string {
	return `${prompt.target} ${prompt.mode} (${prompt.maxTokens} tokens)`;
}

function promptDiagnosticLabel(diagnostic: PluginPromptContributionDiagnostic): string {
	return `${diagnostic.contribution.target} ${diagnostic.contribution.mode} (${diagnostic.contribution.maxTokens} tokens)`;
}

function promptDiagnosticSummary(diagnostic: PluginPromptContributionDiagnostic): string {
	if (diagnostic.included) return "Included in active prompt context.";
	if (diagnostic.reason) return diagnostic.reason;
	if (diagnostic.missingCapabilities.length > 0) return "Missing required capability grants.";
	return "Excluded from active prompt context.";
}

function promptDiagnosticCaps(diagnostic: PluginPromptContributionDiagnostic): string {
	if (diagnostic.missingCapabilities.length > 0) {
		return `Missing: ${diagnostic.missingCapabilities.join(", ")}`;
	}
	return diagnostic.included ? "Included" : "Excluded";
}

function capabilityText(capability: string): string {
	const docs = selectedDiagnostics?.manifest.docs.capabilities[capability];
	if (docs?.summary) return docs.summary;
	return capability;
}

function groupedCapabilities(values: readonly string[]): Array<{ group: string; items: readonly string[] }> {
	const groups = new Map<string, string[]>();
	for (const value of values) {
		const prefix = value.split(":")[0] ?? "plugin";
		const group =
			prefix === "secrets"
				? "Secrets"
				: prefix === "prompt"
					? "Prompts"
					: prefix === "cli"
						? "CLI"
						: prefix === "mcp"
							? "Tools"
							: prefix === "dashboard"
								? "Dashboard"
								: prefix === "connector"
									? "Connectors"
									: prefix === "sdk"
										? "SDK"
										: "Plugin";
		groups.set(group, [...(groups.get(group) ?? []), value]);
	}
	return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
}

function surfaceCapabilityLabel(values: readonly string[]): string {
	return values.length > 0 ? values.join(", ") : "No required capabilities";
}

function auditDataLabel(data: Readonly<Record<string, unknown>>): string {
	const entries = Object.entries(data);
	if (entries.length === 0) return "No metadata";
	return entries
		.slice(0, 2)
		.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" · ");
}

function statusText(plugin: PluginRegistryRecord): string {
	if (!plugin.enabled) return "Off";
	if (formatPluginState(plugin) === "active") return "On";
	return formatPluginState(plugin);
}

function updateText(plugin: PluginRegistryRecord): string {
	if (plugin.trustTier === "core") return "Bundled with Signet";
	return "No updates available";
}

async function refreshSelected(): Promise<void> {
	const plugin = selected;
	if (!plugin) {
		await loadPlugins();
		return;
	}
	const tasks: Promise<unknown>[] = [loadPluginDiagnostics(plugin.id), loadPluginAuditEvents(plugin.id)];
	if (isGraphiqSelected) {
		graphiqError = "";
		tasks.push(loadGraphiqStatus());
	}
	await Promise.all(tasks);
}

async function choosePlugin(id: string): Promise<void> {
	activityPage = 0;
	openDrawer = null;
	graphiqStatus = null;
	graphiqError = "";
	graphiqAction = "";
	await selectPlugin(id);
}

function toggleDrawer(drawer: Drawer): void {
	openDrawer = openDrawer === drawer ? null : drawer;
}

async function handleToggle(plugin: PluginRegistryRecord): Promise<void> {
	const next = !plugin.enabled;
	if (!next && plugin.id === SIGNET_SECRETS_PLUGIN_ID) {
		const ok = window.confirm(
			"Disable Signet Secrets? Secret tools and commands will stop working, but encrypted secrets stay on disk and can be used again if you re-enable the plugin.",
		);
		if (!ok) return;
	}
	await togglePlugin(plugin.id, next);
	if (plugin.id === SIGNET_GRAPHIQ_PLUGIN_ID) {
		graphiqStatus = null;
		graphiqError = "";
		await loadGraphiqStatus();
	}
}

async function loadGraphiqStatus(): Promise<void> {
	graphiqLoading = true;
	graphiqError = "";
	try {
		graphiqStatus = await getGraphiqStatus();
	} catch {
		graphiqStatus = null;
		graphiqError = "Failed to load GraphIQ status";
	}
	graphiqLoading = false;
}

async function handleGraphiqIndex(): Promise<void> {
	const path = indexProjectPath.trim();
	if (!path) {
		graphiqError = "Enter a project path to index.";
		return;
	}
	graphiqAction = "Indexing...";
	graphiqError = "";
	try {
		const result = await indexProjectWithGraphiq(path);
		graphiqAction = "";
		if (!result.success) {
			graphiqError = result.error ?? "Indexing failed";
			return;
		}
		await loadGraphiqStatus();
		indexProjectPath = "";
	} catch {
		graphiqAction = "";
		graphiqError = "Indexing failed";
	}
}

async function handleGraphiqInstall(): Promise<void> {
	graphiqAction = "Installing...";
	graphiqError = "";
	try {
		const result = await apiInstallGraphiq();
		graphiqAction = "";
		if (!result.success) {
			graphiqError = result.error ?? "Install failed";
			return;
		}
		await Promise.all([loadGraphiqStatus(), loadPlugins().then(loadSelectedPluginDetails)]);
	} catch {
		graphiqAction = "";
		graphiqError = "Install failed";
	}
}

async function handleGraphiqUninstall(): Promise<void> {
	graphiqAction = "Uninstalling...";
	graphiqError = "";
	try {
		const result = await apiUninstallGraphiq();
		graphiqAction = "";
		if (!result.success) {
			graphiqError = result.error ?? "Uninstall failed";
			return;
		}
		await Promise.all([loadGraphiqStatus(), loadPlugins().then(loadSelectedPluginDetails)]);
	} catch {
		graphiqAction = "";
		graphiqError = "Uninstall failed";
	}
}

async function handleGraphiqUpdate(): Promise<void> {
	graphiqAction = "Updating...";
	graphiqError = "";
	try {
		const result = await apiUpdateGraphiq();
		graphiqAction = "";
		if (!result.success) {
			graphiqError = result.error ?? "Update failed";
			return;
		}
		await Promise.all([loadGraphiqStatus(), loadPlugins().then(loadSelectedPluginDetails)]);
	} catch {
		graphiqAction = "";
		graphiqError = "Update failed";
	}
}
</script>

<div class="plugins-panel">
	<section class="plugin-list" aria-label="Installed plugins">
		<div class="panel-head">
			<div>
				<div class="eyebrow">Plugins</div>
				<div class="panel-title">{pluginsStore.plugins.length} installed</div>
			</div>
			<Button variant="outline" size="sm" disabled={pluginsStore.loading} onclick={() => loadPlugins().then(refreshSelected)}>
				<RefreshCw class="size-3" />
			</Button>
		</div>

		{#if pluginsStore.error}
			<div class="error-card">{pluginsStore.error}</div>
		{/if}

		{#if pluginsStore.loading && pluginsStore.plugins.length === 0}
			<div class="empty">Loading plugins...</div>
		{:else if pluginsStore.plugins.length === 0}
			<div class="empty">No plugins installed.</div>
		{:else}
			<div class="plugin-cards">
				{#each pluginsStore.plugins as plugin (plugin.id)}
					<button
						class="plugin-card"
						class:plugin-card-active={selected?.id === plugin.id}
						onclick={() => choosePlugin(plugin.id)}
					>
						<div class="plugin-card-top">
							<div>
								<div class="plugin-name">{plugin.name}</div>
								<div class="plugin-id">{plugin.id}</div>
							</div>
							<span class={`state-pill state-${formatPluginState(plugin)}`}>{plugin.enabled ? "on" : "off"}</span>
						</div>
						<div class="plugin-meta">
							<span>{plugin.version}</span>
							<span>{plugin.trustTier}</span>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</section>

	<section class="plugin-detail" aria-label="Plugin details">
		{#if selected}
			<header class="detail-head">
				<div>
					<div class="eyebrow">Plugin</div>
					<h2>{selected.name}</h2>
					<p>{pluginDescription(selected)}</p>
				</div>
				<div class="detail-actions">
					<Button variant="outline" size="sm" disabled={pluginsStore.diagnosticsLoading} onclick={refreshSelected}>
						<RefreshCw class="size-3" />
						Refresh
					</Button>
					{#if isGraphiqSelected && graphiqStatus?.installed}
						<Button variant="outline" size="sm" disabled={graphiqAction !== ""} onclick={handleGraphiqUpdate}>
							{graphiqAction === "Updating..." ? "Updating..." : "Update"}
						</Button>
					{/if}
					{#if isGraphiqSelected}
						{#if graphiqStatus && !graphiqStatus.installed}
							<Button variant="outline" size="sm" disabled={graphiqAction !== ""} onclick={handleGraphiqInstall}>
								Install
							</Button>
						{:else if graphiqStatus?.installed}
							<Button variant="outline" size="sm" disabled={graphiqAction !== ""} onclick={handleGraphiqUninstall}>
								Uninstall
							</Button>
						{/if}
					{/if}
					<Button
						variant="outline"
						size="sm"
						disabled={pluginsStore.togglingId === selected.id}
						onclick={() => handleToggle(selected)}
					>
						{pluginsStore.togglingId === selected.id ? "Updating..." : selected.enabled ? "Turn Off" : "Turn On"}
					</Button>
				</div>
			</header>

			<div class="status-strip">
				<div><span>Status</span><strong>{statusText(selected)}</strong></div>
				<div><span>Version</span><strong>{selected.version}</strong></div>
				<div><span>Updates</span><strong>{updateText(selected)}</strong></div>
				<div><span>Last used</span><strong>{lastAuditEvent ? formatDate(lastAuditEvent.timestamp) : "No activity yet"}</strong></div>
			</div>

			{#if isGraphiqSelected}
				<section class="graphiq-manager">
					<div class="section-title">GraphIQ Management</div>

					{#if graphiqLoading}
						<div class="gm-loading">Loading...</div>
					{:else if !graphiqStatus}
						<div class="gm-loading">Could not load GraphIQ status.</div>
					{/if}

					{#if graphiqError}
						<div class="gm-error">{graphiqError}</div>
					{/if}

					{#if graphiqStatus}
						<div class="gm-status-row">
							<span>Installed</span>
							<strong>{graphiqStatus.installed ? `Yes (${graphiqStatus.installSource ?? "binary"})` : "No"}</strong>
						</div>
						<div class="gm-status-row">
							<span>Enabled</span>
							<strong>{graphiqStatus.pluginEnabled ? "Yes" : "No"}</strong>
						</div>
						<div class="gm-status-row">
							<span>Active project</span>
							<strong>{graphiqStatus.activeProject ?? "None"}</strong>
						</div>
						<div class="gm-status-row">
							<span>Indexed projects</span>
							<strong>{graphiqStatus.indexedProjects.length}</strong>
						</div>

						{#if graphiqAction}
							<div class="gm-action-status">{graphiqAction}</div>
						{/if}

						<div class="gm-index">
							<div class="section-title">Index a project</div>
							<form class="gm-index-form" onsubmit={(e) => { e.preventDefault(); handleGraphiqIndex(); }}>
								<input
									type="text"
									placeholder="/path/to/project"
									bind:value={indexProjectPath}
								/>
								<Button variant="outline" size="sm" type="submit" disabled={graphiqAction !== ""}>
									Index
								</Button>
							</form>
						</div>

						{#if graphiqStatus.indexedProjects.length > 0}
							<div class="gm-projects">
								<div class="section-title">Indexed projects</div>
								{#each graphiqStatus.indexedProjects as project}
									<div class="gm-project-row">
										<span class="gm-project-path">{project.path}</span>
										<span class="gm-project-stats">
											{project.files ? `${project.files} files` : ""}
											{project.symbols ? `${project.symbols} symbols` : ""}
											{project.edges ? `${project.edges} edges` : ""}
										</span>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
				</section>
			{/if}

			<section class="commands-card">
				<div class="section-title">Commands this plugin adds</div>
				{#if selected.surfaces.cliCommands.length === 0 && selected.surfaces.mcpTools.length === 0}
					<div class="empty compact">No commands or tools declared.</div>
				{:else}
					<div class="command-grid">
						{#each selected.surfaces.cliCommands as command (commandPath(command))}
							<div class="command-row">
								<div>
									<div class="row-title">signet {commandPath(command)}</div>
									<div class="row-sub">{command.summary}</div>
								</div>
								<span class="soft-pill">CLI</span>
							</div>
						{/each}
						{#each selected.surfaces.mcpTools as tool (tool.name)}
							<div class="command-row">
								<div>
									<div class="row-title">{tool.title}</div>
									<div class="row-sub">{tool.summary}</div>
								</div>
								<span class="soft-pill">Tool</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<div class="detail-drawers">
				<div class="drawer" class:drawer-open={openDrawer === "permissions"}>
					<button class="drawer-trigger" onclick={() => toggleDrawer("permissions")}>
						<span>Permissions</span><ChevronDown class="size-3" />
					</button>
					<div class="drawer-body">
						{#if selected.grantedCapabilities.length === 0}
							<div class="drawer-empty">No permissions granted.</div>
						{:else}
							<div class="permission-groups">
								{#each groupedCapabilities(selected.grantedCapabilities) as group (group.group)}
									<div class="permission-group-card">
										<div class="permission-head">{group.group}</div>
										<ul>
											{#each group.items as capability (capability)}
												<li>{capabilityText(capability)} <code>{capability}</code></li>
											{/each}
										</ul>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>

				<div class="drawer" class:drawer-open={openDrawer === "activity"}>
					<button class="drawer-trigger" onclick={() => toggleDrawer("activity")}>
						<span>Activity</span><ChevronDown class="size-3" />
					</button>
					<div class="drawer-body">
						{#if pluginsStore.auditLoading}
							<div class="drawer-empty">Loading activity...</div>
						{:else if pluginsStore.auditError}
							<div class="error-card">{pluginsStore.auditError}</div>
						{:else if activityItems.length > 0}
							<div class="activity-head">Real events from the plugin audit log. Page {activityPage + 1} of {activityPageCount}</div>
							<div class="rows">
								{#each activityItems as event (event.id)}
									<div class="activity-row">
										<div>
											<div class="row-title">{event.event}</div>
											<div class="row-sub">{event.source} · {auditDataLabel(event.data)}</div>
											<div class="row-time">{formatDate(event.timestamp)}</div>
										</div>
										<span class={`state-pill state-${event.result}`}>{event.result}</span>
									</div>
								{/each}
							</div>
							<div class="pager">
								<Button variant="outline" size="sm" disabled={activityPage === 0} onclick={() => (activityPage -= 1)}>Previous</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={activityPage >= activityPageCount - 1}
									onclick={() => (activityPage += 1)}
								>
									Next
								</Button>
							</div>
						{:else}
							<div class="drawer-empty">No activity recorded yet.</div>
						{/if}
					</div>
				</div>

				<div class="drawer" class:drawer-open={openDrawer === "advanced"}>
					<button class="drawer-trigger" onclick={() => toggleDrawer("advanced")}>
						<span>Advanced</span><ChevronDown class="size-3" />
					</button>
					<div class="drawer-body">
						<div class="advanced-meta">
							<span>State: {formatPluginState(selected)}</span>
							<span>Health: {selected.health?.status ?? "unknown"}</span>
							<span>Runtime: {selectedDiagnostics?.manifest.runtime.kind ?? "unknown"}</span>
							<span>Source: {selected.source}</span>
						</div>
						{#if isGraphiqSelected && graphiqStatus}
							<div class="advanced-meta">
								<span>Install source: {graphiqStatus.installSource ?? "unknown"}</span>
								<span>Binary: {graphiqStatus.installed ? "found on PATH" : "not found"}</span>
								<span>Plugin state: {graphiqStatus.pluginState}</span>
								<span>Active project: {graphiqStatus.activeProject ?? "none"}</span>
							</div>
							{#if graphiqStatus.indexedProjects.length > 0}
								<div class="surface-section">
									<div class="section-title">Project indexes</div>
									<div class="rows">
										{#each graphiqStatus.indexedProjects as project (project.path)}
											<div class="activity-row">
												<div>
													<div class="row-title">{project.path}</div>
													<div class="row-sub">
														{project.files ? `${project.files} files` : ""}
														{project.symbols ? `${project.symbols} symbols` : ""}
														{project.edges ? `${project.edges} edges` : ""}
														— indexed {formatDate(project.lastIndexedAt)}
													</div>
												</div>
												<span class="soft-pill">{project.path === graphiqStatus.activeProject ? "active" : ""}</span>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						{/if}
						<div class="advanced-grid">
							{@render SurfaceSection("Daemon Routes", selected.surfaces.daemonRoutes, routeLabel)}
							{@render SurfaceSection("Dashboard Panels", selected.surfaces.dashboardPanels, dashboardLabel)}
							{@render SurfaceSection("SDK Clients", selected.surfaces.sdkClients, sdkLabel)}
							{@render SurfaceSection("Connector Capabilities", selected.surfaces.connectorCapabilities, connectorLabel)}
							{@render SurfaceSection("Prompt Contributions", selected.surfaces.promptContributions, promptLabel)}
							{#if selectedDiagnostics}
								{@render PromptDiagnosticsSection(selectedDiagnostics.promptContributionDiagnostics)}
								{@render ValidationErrorsSection(selectedDiagnostics.validationErrors)}
							{/if}
						</div>
					</div>
				</div>
			</div>

		{:else}
			<div class="empty">Select a plugin to inspect what it adds.</div>
		{/if}
	</section>
</div>

{#snippet SurfaceSection<T extends { readonly summary: string; readonly requiredCapabilities: readonly string[] }>(
	title: string,
	items: readonly T[],
	label: (item: T) => string,
)}
	<div class="surface-section">
		<div class="section-title">{title}</div>
		{#if items.length === 0}
			<div class="drawer-empty">None declared.</div>
		{:else}
			<div class="rows">
				{#each items as item (label(item))}
					<div class="activity-row">
						<div>
							<div class="row-title">{label(item)}</div>
							<div class="row-sub">{item.summary}</div>
						</div>
						<div class="surface-caps">{surfaceCapabilityLabel(item.requiredCapabilities)}</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet PromptDiagnosticsSection(items: readonly PluginPromptContributionDiagnostic[])}
	<div class="surface-section">
		<div class="section-title">Prompt Diagnostics</div>
		{#if items.length === 0}
			<div class="drawer-empty">No prompt diagnostics reported.</div>
		{:else}
			<div class="rows">
				{#each items as item (item.contribution.id)}
					<div class="activity-row">
						<div>
							<div class="row-title">{item.contribution.id}</div>
							<div class="row-sub">{promptDiagnosticLabel(item)} · {promptDiagnosticSummary(item)}</div>
						</div>
						<div class="surface-caps">{promptDiagnosticCaps(item)}</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet ValidationErrorsSection(items: readonly string[])}
	<div class="surface-section">
		<div class="section-title">Validation Errors</div>
		{#if items.length === 0}
			<div class="drawer-empty">No validation errors.</div>
		{:else}
			<div class="rows">
				{#each items as item (item)}
					<div class="activity-row">
						<div>
							<div class="row-title">Validation error</div>
							<div class="row-sub">{item}</div>
						</div>
						<span class="state-pill state-error">error</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<style>
	.plugins-panel {
		display: grid;
		grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
		gap: 1px;
		height: 100%;
		min-height: 0;
		background: var(--sig-border);
	}

	.plugin-list,
	.plugin-detail {
		min-height: 0;
		background: var(--sig-bg);
		padding: var(--space-md);
	}

	.plugin-list {
		overflow: auto;
	}

	.plugin-detail {
		overflow: hidden;
	}

	.panel-head,
	.detail-head,
	.plugin-card-top,
	.plugin-meta,
	.detail-actions,
	.command-row,
	.activity-row,
	.pager,
	.drawer-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.panel-head,
	.detail-head {
		margin-bottom: 6px;
	}

	.detail-head {
		align-items: flex-start;
	}

	.eyebrow,
	.section-title,
	.activity-head {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.panel-title {
		margin-top: 2px;
		font-family: var(--font-display);
		font-size: 15px;
		color: var(--sig-text-bright);
	}

	h2 {
		margin: 2px 0 4px;
		font-family: var(--font-display);
		font-size: 23px;
		line-height: 1.1;
		color: var(--sig-text-bright);
	}

	p {
		max-width: 760px;
		margin: 0;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.45;
		color: var(--sig-text-muted);
	}

	.plugin-cards,
	.command-grid,
	.detail-drawers,
	.rows,
	.permission-groups {
		display: grid;
		gap: var(--space-xs);
	}

	.plugin-card,
	.commands-card,
	.drawer,
	.status-strip,
	.error-card,
	.empty {
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
	}

	.plugin-card,
	.commands-card {
		padding: 8px;
	}

	.plugin-card {
		width: 100%;
		text-align: left;
		cursor: pointer;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.plugin-card:hover,
	.plugin-card-active {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 94%);
	}

	.plugin-name,
	.row-title,
	.permission-head,
	.drawer-trigger span {
		font-family: var(--font-display);
		font-size: 12px;
		color: var(--sig-text-bright);
	}

	.plugin-id,
	.plugin-meta,
	.row-sub,
	.row-time,
	.surface-caps,
	.advanced-meta,
	.drawer-empty,
	.status-strip span,
	.status-strip strong {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.plugin-meta {
		justify-content: flex-start;
		margin-top: 4px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.status-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1px;
		margin-bottom: var(--space-sm);
		padding: 0;
		overflow: hidden;
	}

	.status-strip div {
		padding: 8px 10px;
		border-right: 1px solid var(--sig-border);
	}

	.status-strip div:last-child {
		border-right: none;
	}

	.status-strip span,
	.status-strip strong {
		display: block;
	}

	.status-strip strong {
		margin-top: 2px;
		color: var(--sig-text-bright);
	}

	.commands-card {
		margin-bottom: 6px;
	}

	.command-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		max-height: 112px;
		overflow: auto;
		margin-top: var(--space-xs);
		scrollbar-width: thin;
	}

	.command-row,
	.activity-row {
		align-items: flex-start;
		padding: 3px 0;
		border-top: 1px solid var(--sig-border);
	}

	.command-row:nth-child(1),
	.command-row:nth-child(2),
	.activity-row:first-child {
		border-top: none;
	}

	.state-pill,
	.soft-pill {
		flex: 0 0 auto;
		padding: 1px 5px;
		border: 1px solid var(--sig-border);
		border-radius: 999px;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.state-active,
	.state-ok {
		border-color: color-mix(in srgb, var(--sig-success), transparent 45%);
		color: var(--sig-success);
	}

	.state-degraded {
		border-color: color-mix(in srgb, var(--sig-warning), transparent 45%);
		color: var(--sig-warning);
	}

	.state-disabled,
	.state-denied,
	.state-error,
	.state-unhealthy {
		border-color: color-mix(in srgb, var(--sig-danger), transparent 45%);
		color: var(--sig-danger);
	}

	.drawer {
		overflow: hidden;
		transition:
			background var(--dur) var(--ease),
			border-color var(--dur) var(--ease);
	}

	.drawer:hover,
	.drawer-open {
		border-color: color-mix(in srgb, var(--sig-highlight), var(--sig-border) 45%);
		background: color-mix(in srgb, var(--sig-highlight), var(--sig-surface) 96%);
	}

	.drawer-trigger {
		width: 100%;
		min-height: 34px;
		padding: 7px 9px 7px 10px;
		background: color-mix(in srgb, var(--sig-bg), var(--sig-surface) 55%);
		border: none;
		box-shadow: inset 0 -1px 0 var(--sig-border);
		cursor: pointer;
		color: var(--sig-text-bright);
		text-align: left;
		transition:
			background var(--dur) var(--ease),
			box-shadow var(--dur) var(--ease);
	}

	.drawer-trigger:hover {
		background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 92%);
	}

	.drawer-trigger:focus-visible {
		outline: 1px solid var(--sig-highlight);
		outline-offset: -2px;
	}

	.drawer-trigger :global(svg) {
		width: 18px;
		height: 18px;
		padding: 2px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		color: var(--sig-text-muted);
		transition:
			transform 180ms var(--ease),
			border-color var(--dur) var(--ease),
			color var(--dur) var(--ease);
	}

	.drawer-trigger:hover :global(svg),
	.drawer-open .drawer-trigger :global(svg) {
		border-color: var(--sig-highlight);
		color: var(--sig-highlight);
	}

	.drawer-open .drawer-trigger {
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--sig-border);
		background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 90%);
	}

	.drawer-open .drawer-trigger :global(svg) {
		transform: rotate(180deg);
	}

	.drawer-body {
		max-height: 0;
		overflow: hidden;
		padding: 0 8px;
		opacity: 0;
		transition:
			max-height 220ms var(--ease),
			opacity 160ms var(--ease),
			padding-top 220ms var(--ease),
			padding-bottom 220ms var(--ease);
	}

	.drawer-open .drawer-body {
		max-height: 210px;
		overflow: auto;
		padding-top: var(--space-xs);
		padding-bottom: 8px;
		opacity: 1;
		scrollbar-width: thin;
	}

	.permission-group-card,
	.surface-section {
		padding: var(--space-sm);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
	}

	.permission-group-card ul {
		margin: 4px 0 0;
		padding-left: 1rem;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.55;
		color: var(--sig-text-muted);
	}

	.permission-group-card code {
		color: var(--sig-highlight);
	}

	.activity-head {
		margin-bottom: var(--space-xs);
	}

	.pager {
		justify-content: flex-end;
		margin-top: var(--space-xs);
	}

	.advanced-meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-bottom: var(--space-xs);
	}

	.advanced-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-xs);
	}

	.surface-caps {
		max-width: 42%;
		text-align: right;
	}

	.error-card,
	.empty,
	.drawer-empty {
		padding: var(--space-sm);
	}

	.error-card {
		color: var(--sig-danger);
	}

	.compact {
		padding: var(--space-xs);
	}

	.graphiq-manager {
		padding: var(--space-sm);
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		margin-bottom: var(--space-sm);
	}

	.gm-status-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 4px 0;
		border-top: 1px solid var(--sig-border);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.gm-status-row:first-of-type {
		border-top: none;
	}

	.gm-status-row strong {
		color: var(--sig-text-bright);
	}

	.gm-action-status {
		margin-top: var(--space-xs);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-highlight);
	}

	.gm-error {
		padding: var(--space-xs);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-danger);
	}

	.gm-loading {
		padding: var(--space-xs);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.gm-index {
		margin-top: var(--space-sm);
	}

	.gm-index-form {
		display: flex;
		gap: var(--space-xs);
		margin-top: var(--space-xs);
	}

	.gm-index-form input {
		flex: 1;
		min-width: 0;
		padding: 5px 8px;
		font-family: var(--font-mono);
		font-size: 10px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		color: var(--sig-text-bright);
		outline: none;
		transition: border-color var(--dur) var(--ease);
	}

	.gm-index-form input:focus {
		border-color: var(--sig-highlight);
	}

	.gm-index-form input::placeholder {
		color: var(--sig-text-muted);
	}

	.gm-projects {
		margin-top: var(--space-sm);
	}

	.gm-project-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 3px 0;
		border-top: 1px solid var(--sig-border);
	}

	.gm-project-row:first-of-type {
		border-top: none;
	}

	.gm-project-path {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-bright);
	}

	.gm-project-stats {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	@media (max-width: 1120px) {
		.plugins-panel,
		.command-grid,
		.advanced-grid,
		.status-strip {
			grid-template-columns: 1fr;
		}

		.plugin-detail {
			overflow: auto;
		}
	}
</style>
