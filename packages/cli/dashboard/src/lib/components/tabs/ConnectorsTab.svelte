<script lang="ts">
import { onMount } from "svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import {
	getHarnesses,
	getConnectors,
	getConfigFiles,
	API_BASE,
	regenerateHarnesses,
	resyncConnectors,
	syncConnector,
	syncConnectorFull,
	type Harness,
	type DocumentConnector,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";
import { parse } from "yaml";

interface ConnectorHealth {
	documentCount: number;
}

let harnesses = $state<Harness[]>([]);
let connectors = $state<DocumentConnector[]>([]);
let connectorHealthMap = $state<Map<string, ConnectorHealth>>(new Map());
let enabledHarnessIds = $state<Set<string>>(new Set());
let loading = $state(true);
let syncingId = $state<string | null>(null);
let syncMenuOpen = $state<string | null>(null);
let harnessResyncing = $state(false);
let connectorsResyncing = $state(false);

function relativeTime(iso: string | null): string {
	if (!iso) return "never";
	const ts = new Date(iso).getTime();
	if (Number.isNaN(ts)) return "unknown";
	const diff = Date.now() - ts;
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
	if (status === "error") return "destructive";
	if (status === "syncing") return "default";
	return "secondary";
}

async function load() {
	let loadedConnectors: DocumentConnector[] = [];
	try {
		const [h, c] = await Promise.all([getHarnesses(), getConnectors()]);
		harnesses = h;
		connectors = c;
		loadedConnectors = c;

		if (h.some((harness) => harness.enabled === undefined)) {
			const configFiles = await getConfigFiles();
			enabledHarnessIds = readEnabledHarnesses(configFiles);
		} else {
			enabledHarnessIds = new Set();
		}
	} catch {
		// Keep previously rendered data if this refresh fails
	} finally {
		loading = false;
		void fetchConnectorHealth(loadedConnectors);
	}
}

function readEnabledHarnesses(
	files: Array<{ name: string; content: string }>,
): Set<string> {
	const file =
		files.find((f) => f.name === "agent.yaml") ??
		files.find((f) => f.name === "AGENT.yaml");
	if (!file) return new Set();

	try {
		const data = parse(file.content) as { harnesses?: unknown };
		if (!Array.isArray(data.harnesses)) return new Set();
		const ids = data.harnesses
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return new Set(ids);
	} catch {
		return new Set();
	}
}

async function fetchConnectorHealth(conns: DocumentConnector[]): Promise<void> {
	const healthPromises = conns.map(async (conn) => {
		try {
			const res = await fetch(`${API_BASE}/api/connectors/${encodeURIComponent(conn.id)}/health`);
			if (res.ok) {
				const data = await res.json() as ConnectorHealth;
				return { id: conn.id, health: data };
			}
		} catch {
			// Ignore health fetch errors
		}
		return null;
	});
	
	const results = await Promise.all(healthPromises);
	const newMap = new Map<string, ConnectorHealth>();
	for (const result of results) {
		if (result) {
			newMap.set(result.id, result.health);
		}
	}
	connectorHealthMap = newMap;
}

async function triggerHarnessResync(): Promise<void> {
	harnessResyncing = true;
	try {
		const result = await regenerateHarnesses();
		if (!result.success) {
			toast(`Harness re-sync failed: ${result.error ?? "unknown error"}`, "error");
			return;
		}
		toast(result.message ?? "Harness re-sync completed", "success");
		await load();
	} catch (e) {
		toast(`Harness re-sync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
	} finally {
		harnessResyncing = false;
	}
}

function buildConnectorResyncMessage(result: {
	started: number;
	alreadySyncing: number;
	unsupported: number;
	failed: number;
	total: number;
}): string {
	const parts: string[] = [];
	parts.push(`Started ${result.started}`);
	if (result.alreadySyncing > 0) parts.push(`${result.alreadySyncing} already syncing`);
	if (result.unsupported > 0) parts.push(`${result.unsupported} unsupported`);
	if (result.failed > 0) parts.push(`${result.failed} failed`);
	parts.push(`of ${result.total}`);
	return `Connector re-sync summary: ${parts.join(", ")}`;
}

async function triggerConnectorsResync(): Promise<void> {
	if (connectors.length === 0) {
		toast("No document connectors configured", "error");
		return;
	}

	connectorsResyncing = true;
	try {
		const result = await resyncConnectors();
		if (result.status === "error") {
			toast(`Connector re-sync failed: ${result.error ?? "unknown error"}`, "error");
			return;
		}

		const message = buildConnectorResyncMessage(result);
		if (result.failed > 0) {
			toast(message, "error");
		} else {
			toast(message, "success");
		}
		await load();
	} catch (e) {
		toast(`Connector re-sync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
	} finally {
		connectorsResyncing = false;
	}
}

async function triggerSync(conn: DocumentConnector): Promise<void> {
	const name = conn.display_name ?? conn.id;
	syncMenuOpen = null;
	syncingId = conn.id;
	try {
		const result = await syncConnector(conn.id);
		if (result.error) {
			toast(`Sync failed: ${result.error}`, "error");
		} else {
			toast(`Sync started for ${name}`, "success");
			await load();
		}
	} catch (e) {
		toast(`Sync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
	} finally {
		syncingId = null;
	}
}

async function triggerFullSync(conn: DocumentConnector): Promise<void> {
	const name = conn.display_name ?? conn.id;
	syncMenuOpen = null;

	const confirmed = window.confirm(
		`Full resync will clear all documents from "${name}" and reindex everything. This may take a while.\n\nContinue?`,
	);
	if (!confirmed) return;

	syncingId = conn.id;
	try {
		const result = await syncConnectorFull(conn.id);
		if (result.error) {
			toast(`Full resync failed: ${result.error}`, "error");
		} else {
			toast(`Full resync started for ${name}`, "success");
			await load();
		}
	} catch (e) {
		toast(`Full resync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
	} finally {
		syncingId = null;
	}
}

onMount(() => {
	load();
	const timer = setInterval(load, 30_000);
	return () => clearInterval(timer);
});
</script>

<div class="flex flex-col flex-1 min-h-0 p-[var(--space-sm)] lg:p-[var(--space-md)] gap-[var(--space-md)] overflow-y-auto">
	{#if loading}
		<div class="flex flex-1 items-center justify-center sig-label">
			Loading connectors...
		</div>
	{:else}
		<!-- Platform Harnesses -->
		<section class="rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] overflow-hidden">
			<div class="harness-header flex items-center justify-between px-[var(--space-md)] py-[var(--space-sm)] border-b border-[var(--sig-border)]">
				<h3 class="sig-heading tracking-[0.08em]">
					Platform Harnesses
				</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={harnessResyncing}
					class="sig-label px-2 py-1 h-auto hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
					onclick={triggerHarnessResync}
				>
					{harnessResyncing ? "Re-syncing..." : "Re-sync"}
				</Button>
			</div>
			<div class="grid gap-[var(--space-sm)] p-[var(--space-md)] sm:grid-cols-2 lg:grid-cols-3">
				{#each harnesses as h (h.id)}
					{@const isEnabled = h.enabled ?? enabledHarnessIds.has(h.id)}
					<div class="harness-card flex flex-col gap-[var(--space-sm)] p-[var(--space-md)] rounded-lg border border-[var(--sig-border)] bg-[var(--sig-surface)] transition-colors hover:border-[var(--sig-border-strong)]">
						<span class="text-[13px] font-semibold text-[var(--sig-text-bright)] font-[family-name:var(--font-display)] tracking-[0.04em]">
							{h.name}
						</span>
						<Tooltip.Provider>
							<Tooltip.Root>
								<Tooltip.Trigger class="text-left">
									<span class="sig-eyebrow truncate block max-w-[220px]">
										{h.path}
									</span>
								</Tooltip.Trigger>
								<Tooltip.Content class="max-w-[400px] break-all">
									{h.path}
								</Tooltip.Content>
							</Tooltip.Root>
						</Tooltip.Provider>
						<div class="flex items-center justify-between gap-3 sig-eyebrow">
							<span>{h.exists ? "Config found" : "Config not found"}</span>
							<span
								class={`harness-state ${isEnabled ? "harness-state--enabled" : "harness-state--disabled"}`}
							>
								{isEnabled ? "Enabled" : "Disabled"}
							</span>
						</div>
					</div>
				{/each}
			</div>
		</section>

		<!-- Document Connectors -->
		<section class="rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] overflow-hidden">
			<div class="connector-header flex items-center justify-between px-[var(--space-md)] py-[var(--space-sm)] border-b border-[var(--sig-border)]">
				<h3 class="sig-heading tracking-[0.08em]">
					Document Connectors
				</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={connectorsResyncing || connectors.length === 0}
					class="sig-label px-2 py-1 h-auto hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
					onclick={triggerConnectorsResync}
				>
					{connectorsResyncing ? "Re-syncing..." : "Re-sync"}
				</Button>
			</div>
			{#if connectors.length === 0}
				<div class="flex items-center justify-center py-[var(--space-xl)] sig-label text-[var(--sig-text-muted)]">
					No document connectors configured
				</div>
			{:else}
				<div class="grid gap-[var(--space-sm)] p-[var(--space-md)] sm:grid-cols-2 lg:grid-cols-3">
					{#each connectors as conn (conn.id)}
						{@const health = connectorHealthMap.get(conn.id)}
						<div class="connector-card flex flex-col gap-[var(--space-sm)] p-[var(--space-md)] rounded-lg border border-[var(--sig-border)] bg-[var(--sig-surface)] transition-colors hover:border-[var(--sig-border-strong)]">
							<div class="flex items-start justify-between gap-2">
								<div class="flex flex-col gap-1 min-w-0 flex-1">
									<span class="text-[13px] font-semibold text-[var(--sig-text-bright)] font-[family-name:var(--font-display)] tracking-[0.04em]">
										{conn.display_name ?? conn.id}
									</span>
									<span class="sig-eyebrow">
										{conn.provider}
									</span>
								</div>
								<Badge variant={statusVariant(conn.status)} class="shrink-0">
									{conn.status}
								</Badge>
							</div>

							<div class="flex items-center gap-3 sig-eyebrow">
								{#if health?.documentCount !== undefined}
									<span class="flex items-center gap-1">
										<span class="text-[var(--sig-text-bright)] font-medium">{health.documentCount.toLocaleString()}</span>
										docs
									</span>
								{/if}
								<span>
									{#if conn.status === "syncing" || syncingId === conn.id}
										Syncing...
									{:else if conn.last_sync_at}
										Synced {relativeTime(conn.last_sync_at)}
									{:else}
										Never synced
									{/if}
								</span>
							</div>

							{#if conn.last_error}
								<Tooltip.Provider>
									<Tooltip.Root>
										<Tooltip.Trigger class="text-left">
											<span class="sig-eyebrow text-[var(--sig-danger)] truncate block">
												Error: {conn.last_error.slice(0, 50)}{conn.last_error.length > 50 ? "..." : ""}
											</span>
										</Tooltip.Trigger>
										<Tooltip.Content class="max-w-[400px] break-all text-[var(--sig-danger)]">
											{conn.last_error}
										</Tooltip.Content>
									</Tooltip.Root>
								</Tooltip.Provider>
							{/if}

							<div class="flex items-center gap-2 mt-auto pt-[var(--space-xs)] border-t border-[var(--sig-border)]">
								<Popover.Root open={syncMenuOpen === conn.id} onOpenChange={(open) => { syncMenuOpen = open ? conn.id : null; }}>
									<Popover.Trigger class="flex-1">
										{#snippet child({ props })}
											<Button
												{...props}
												variant="outline"
												size="sm"
												disabled={conn.status === "syncing" || syncingId === conn.id}
												class="w-full sig-eyebrow px-2 py-1 h-auto hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)] disabled:opacity-50"
											>
												Sync ▾
											</Button>
										{/snippet}
									</Popover.Trigger>
									<Popover.Content
										align="start"
										side="top"
										class="w-[160px] p-1 bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg"
									>
										<div class="flex flex-col gap-1">
											<Button
												variant="ghost"
												size="sm"
												class="w-full justify-start sig-eyebrow px-2 py-1.5 h-auto hover:bg-[var(--sig-surface)]"
												onclick={() => triggerSync(conn)}
											>
												Incremental Sync
											</Button>
											<Button
												variant="ghost"
												size="sm"
												class="w-full justify-start sig-eyebrow px-2 py-1.5 h-auto text-[var(--sig-danger)] hover:bg-[color-mix(in_srgb,var(--sig-danger)_10%,transparent)]"
												onclick={() => triggerFullSync(conn)}
											>
												Full Resync
											</Button>
										</div>
									</Popover.Content>
								</Popover.Root>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
.harness-header {
	background:
		radial-gradient(
			circle at 0% 0%,
			color-mix(in srgb, var(--sig-success) 8%, transparent),
			transparent 50%
		),
		var(--sig-surface-raised);
}

.connector-header {
	background:
		radial-gradient(
			circle at 100% 0%,
			color-mix(in srgb, var(--sig-accent) 12%, transparent),
			transparent 50%
		),
		var(--sig-surface-raised);
}

.harness-card,
.connector-card {
	background:
		linear-gradient(
			145deg,
			color-mix(in srgb, var(--sig-surface) 95%, var(--sig-bg)) 0%,
			var(--sig-surface) 100%
		);
}

.harness-state {
	padding: 2px 8px;
	border-radius: 6px;
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	border: 1px solid transparent;
}

.harness-state--enabled {
	color: var(--sig-success);
	border-color: color-mix(in srgb, var(--sig-success) 45%, transparent);
	background: color-mix(in srgb, var(--sig-success) 12%, transparent);
}

.harness-state--disabled {
	color: var(--sig-danger);
	border-color: color-mix(in srgb, var(--sig-danger) 45%, transparent);
	background: color-mix(in srgb, var(--sig-danger) 12%, transparent);
}
</style>
