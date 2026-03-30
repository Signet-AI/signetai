<script lang="ts">
import {
	type DocumentConnector,
	type Harness,
	getConnectors,
	getHarnesses,
	regenerateHarnesses,
	resyncConnectors,
	syncConnector,
	syncConnectorFull,
} from "$lib/api";
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
import { ENGINE_TAB_ITEMS } from "$lib/components/layout/page-headers";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import { nav } from "$lib/stores/navigation.svelte";
import { focusEngineTab } from "$lib/stores/tab-group-focus.svelte";
import { toast } from "$lib/stores/toast.svelte";
import { onMount } from "svelte";

let harnesses = $state<Harness[]>([]);
let connectors = $state<DocumentConnector[]>([]);
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
	try {
		const [h, c] = await Promise.all([getHarnesses(), getConnectors()]);
		harnesses = h;
		connectors = c;
	} finally {
		loading = false;
	}
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

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	<PageBanner title="Connectors">
		<TabGroupBar
			group="engine"
			tabs={ENGINE_TAB_ITEMS}
			activeTab={nav.activeTab}
			onselect={(_tab, index) => focusEngineTab(index)}
		/>
	</PageBanner>
	<div class="flex flex-1 flex-col gap-6 p-4 overflow-y-auto">
	{#if loading}
		<div class="flex flex-1 items-center justify-center sig-label">
			Loading connectors...
		</div>
	{:else}
		<!-- Platform Harnesses -->
		<section>
			<div class="flex items-center justify-between mb-3 gap-3">
				<h3 class="sig-label uppercase tracking-[0.1em]">
					Platform Harnesses
				</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={harnessResyncing}
					class="sig-meta uppercase tracking-[0.08em] h-auto px-2 py-1"
					onclick={triggerHarnessResync}
				>
					{harnessResyncing ? "Re-syncing..." : "Re-sync Harnesses"}
				</Button>
			</div>
			<div class="grid gap-2">
				{#each harnesses as h (h.id)}
					<div
						class="flex items-center gap-3 px-3 py-2.5
							border border-[var(--sig-border)]
							bg-[var(--sig-surface-raised)]"
					>
						<span
							class="inline-block h-2 w-2 shrink-0"
							class:bg-[var(--sig-success)]={h.exists}
							class:border={!h.exists}
							class:border-[var(--sig-text-muted)]={!h.exists}
						></span>
						<div class="flex flex-col gap-0.5 min-w-0 flex-1">
							<span class="text-[12px] font-medium text-[var(--sig-text-bright)]
								font-[family-name:var(--font-display)] tracking-[0.04em]">
								{h.name}
							</span>
							<span class="sig-eyebrow truncate">
								{h.path}
							</span>
						</div>
						<div class="flex flex-col items-end gap-0.5 shrink-0">
							<span
								class="sig-eyebrow"
								class:text-[var(--sig-text-bright)]={h.exists}
								class:text-[var(--sig-text-muted)]={!h.exists}
							>
								{h.exists ? "installed" : "not found"}
							</span>
							<span class="sig-eyebrow">
								{#if h.lastSeen}
									seen {relativeTime(h.lastSeen)}
								{:else}
									no activity
								{/if}
							</span>
						</div>
					</div>
				{/each}
			</div>
		</section>

		<!-- Document Connectors -->
		<section>
			<div class="flex items-center justify-between mb-3 gap-3">
				<h3 class="sig-label uppercase tracking-[0.1em]">
					Document Connectors
				</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={connectorsResyncing || connectors.length === 0}
					class="sig-meta uppercase tracking-[0.08em] h-auto px-2 py-1"
					onclick={triggerConnectorsResync}
				>
					{connectorsResyncing ? "Re-syncing..." : "Re-sync Connectors"}
				</Button>
			</div>
			{#if connectors.length === 0}
				<div class="flex items-center justify-center py-8
					sig-label border border-dashed border-[var(--sig-border)]">
					No document connectors configured
				</div>
			{:else}
				<div class="grid gap-2">
					{#each connectors as conn (conn.id)}
						<div
							class="flex items-center gap-3 px-3 py-2.5
								border border-[var(--sig-border)]
								bg-[var(--sig-surface-raised)]"
						>
							<Badge variant={statusVariant(conn.status)}>
								{conn.status}
							</Badge>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<span class="text-[12px] font-medium text-[var(--sig-text-bright)]
									font-[family-name:var(--font-display)] tracking-[0.04em]">
									{conn.display_name ?? conn.id}
								</span>
								<span class="sig-eyebrow">
									{conn.provider}
								</span>
							</div>
							<div class="flex flex-col items-end gap-0.5 shrink-0">
								<div class="flex items-center gap-2">
									<span class="sig-eyebrow">
										{#if conn.status === "syncing" || syncingId === conn.id}
											syncing...
										{:else if conn.last_sync_at}
											synced {relativeTime(conn.last_sync_at)}
										{:else}
											never synced
										{/if}
									</span>
									<Popover.Root open={syncMenuOpen === conn.id} onOpenChange={(open) => { syncMenuOpen = open ? conn.id : null; }}>
										<Popover.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													variant="outline"
													size="sm"
													disabled={conn.status === "syncing" || syncingId === conn.id}
													class="sig-meta uppercase tracking-[0.08em] px-2 py-0.5 h-auto
														hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]
														disabled:opacity-50 disabled:cursor-not-allowed"
												>
													Sync ▾
												</Button>
											{/snippet}
										</Popover.Trigger>
										<Popover.Content
											align="end"
											side="bottom"
											class="w-[140px] p-1 bg-[var(--sig-surface-raised)]
												border-[var(--sig-border-strong)] rounded-lg"
										>
											<div class="flex flex-col gap-1">
												<Button
													variant="outline"
													size="sm"
													class="w-full justify-start sig-eyebrow tracking-[0.08em] px-2 py-1 h-auto
														hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]"
													onclick={() => triggerSync(conn)}
												>
													Sync
												</Button>
												<Button
													variant="outline"
													size="sm"
													class="w-full justify-start sig-eyebrow tracking-[0.08em] px-2 py-1 h-auto
														text-[var(--sig-danger)]
														hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-danger)]"
													onclick={() => triggerFullSync(conn)}
												>
													Full Resync
												</Button>
											</div>
										</Popover.Content>
									</Popover.Root>
								</div>
								{#if conn.last_error}
									<span
										class="sig-eyebrow text-[var(--sig-danger)] truncate max-w-[200px]"
										title={conn.last_error}
									>
										{conn.last_error}
									</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
	</div>
</div>
