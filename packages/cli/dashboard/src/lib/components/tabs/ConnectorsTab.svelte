<script lang="ts">
	import { onMount } from "svelte";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import {
		getHarnesses,
		getConnectors,
		type Harness,
		type DocumentConnector,
	} from "$lib/api";

	let harnesses = $state<Harness[]>([]);
	let connectors = $state<DocumentConnector[]>([]);
	let loading = $state(true);

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

	function statusVariant(
		status: string,
	): "default" | "secondary" | "destructive" | "outline" {
		if (status === "error") return "destructive";
		if (status === "syncing") return "default";
		return "secondary";
	}

	async function load() {
		const [h, c] = await Promise.all([getHarnesses(), getConnectors()]);
		harnesses = h;
		connectors = c;
		loading = false;
	}

	onMount(() => {
		load();
		const timer = setInterval(load, 30_000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex flex-1 flex-col gap-6 p-4 overflow-y-auto">
	{#if loading}
		<div
			class="flex flex-1 items-center justify-center text-[12px]
				text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]"
		>
			Loading connectors...
		</div>
	{:else}
		<!-- Platform Harnesses -->
		<section>
			<h3
				class="text-[11px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)]
					font-[family-name:var(--font-mono)] mb-3"
			>
				Platform Harnesses
			</h3>
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
							<span
								class="text-[12px] font-medium text-[var(--sig-text-bright)]
									font-[family-name:var(--font-display)] tracking-[0.04em]"
							>
								{h.name}
							</span>
							<span
								class="text-[10px] text-[var(--sig-text-muted)]
									font-[family-name:var(--font-mono)] truncate"
							>
								{h.path}
							</span>
						</div>
						<div class="flex flex-col items-end gap-0.5 shrink-0">
							<span
								class="text-[10px] font-[family-name:var(--font-mono)]"
								class:text-[var(--sig-text-bright)]={h.exists}
								class:text-[var(--sig-text-muted)]={!h.exists}
							>
								{h.exists ? "installed" : "not found"}
							</span>
							<span
								class="text-[10px] text-[var(--sig-text-muted)]
									font-[family-name:var(--font-mono)]"
							>
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
			<h3
				class="text-[11px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)]
					font-[family-name:var(--font-mono)] mb-3"
			>
				Document Connectors
			</h3>
			{#if connectors.length === 0}
				<div
					class="flex items-center justify-center py-8
						text-[12px] text-[var(--sig-text-muted)]
						font-[family-name:var(--font-mono)]
						border border-dashed border-[var(--sig-border)]"
				>
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
								<span
									class="text-[12px] font-medium text-[var(--sig-text-bright)]
										font-[family-name:var(--font-display)] tracking-[0.04em]"
								>
									{conn.display_name ?? conn.id}
								</span>
								<span
									class="text-[10px] text-[var(--sig-text-muted)]
										font-[family-name:var(--font-mono)]"
								>
									{conn.provider}
								</span>
							</div>
							<div class="flex flex-col items-end gap-0.5 shrink-0">
								<span
									class="text-[10px] text-[var(--sig-text-muted)]
										font-[family-name:var(--font-mono)]"
								>
									{#if conn.last_sync_at}
										synced {relativeTime(conn.last_sync_at)}
									{:else}
										never synced
									{/if}
								</span>
								{#if conn.last_error}
									<span
										class="text-[10px] text-[var(--sig-danger)]
											font-[family-name:var(--font-mono)] truncate max-w-[200px]"
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
