<script lang="ts">
import type { Memory } from "$lib/api";
import { setMemoryPinned, updateMemory } from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { toast } from "$lib/stores/toast.svelte";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";

interface Props {
	memories: Memory[];
}

let { memories }: Props = $props();

let actedIds = $state<Set<string>>(new Set());
let displayOffset = $state(0);
let listEl: HTMLDivElement | undefined = $state();
let visibleCount = $state(3);

const ENTRY_HEIGHT = 90; // approximate height per insight entry

function scoreMemory(m: Memory): number {
	const now = Date.now();
	const age = now - new Date(m.created_at).getTime();
	const dayMs = 86_400_000;
	const recency = age < 7 * dayMs ? 1 : age < 30 * dayMs ? 0.5 : 0.2;
	const tags = parseTags(m.tags);
	const curationNeed = tags.length === 0 ? 1 : tags.length < 3 ? 0.6 : 0.2;
	const imp = m.importance ?? 0.5;
	const importanceMid = imp >= 0.3 && imp <= 0.7 ? 1 : 0.3;
	return recency + curationNeed + importanceMid;
}

function parseTags(raw: string | string[] | null | undefined): string[] {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw.filter(Boolean);
	return raw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

const scoredPool = $derived(
	memories
		.filter((m) => {
			if (actedIds.has(m.id)) return false;
			if (m.pinned) return false;
			const tags = parseTags(m.tags);
			if (tags.includes("rejected-insight")) return false;
			return true;
		})
		.map((m) => ({ memory: m, score: scoreMemory(m) }))
		.sort((a, b) => b.score - a.score),
);

const displayCards = $derived.by(() => {
	if (scoredPool.length === 0) return [];
	const count = Math.min(visibleCount, scoredPool.length);
	const start = displayOffset % scoredPool.length;
	return Array.from({ length: count }, (_, i) => scoredPool[(start + i) % scoredPool.length].memory);
});

$effect(() => {
	if (!listEl) return;
	const observer = new ResizeObserver((entries) => {
		const height = entries[0]?.contentRect.height ?? 0;
		visibleCount = Math.max(1, Math.floor(height / ENTRY_HEIGHT));
	});
	observer.observe(listEl);
	return () => observer.disconnect();
});

function importanceColor(imp: number): string {
	if (imp >= 0.8) return "var(--sig-danger)";
	if (imp >= 0.5) return "var(--sig-warning)";
	return "var(--sig-success)";
}

function formatDate(dateStr: string): string {
	const d = new Date(dateStr);
	const month = d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
	const day = String(d.getDate()).padStart(2, "0");
	return `${month} ${day}`;
}

async function acceptMemory(m: Memory): Promise<void> {
	const result = await setMemoryPinned(m.id, true);
	if (result.success) {
		actedIds = new Set([...actedIds, m.id]);
		toast("Memory pinned", "success");
	} else {
		toast(result.error ?? "Failed to pin", "error");
	}
}

async function rejectMemory(m: Memory): Promise<void> {
	const existing = parseTags(m.tags);
	existing.push("rejected-insight");
	const result = await updateMemory(m.id, { tags: existing.join(",") }, "dashboard: rejected insight");
	if (result.success) {
		actedIds = new Set([...actedIds, m.id]);
		toast("Memory dismissed", "success");
	} else {
		toast(result.error ?? "Failed to dismiss", "error");
	}
}

const editContent = $state<Record<string, string>>({});

function initEdit(m: Memory): void {
	editContent[m.id] = m.content;
}

async function saveCorrection(m: Memory): Promise<void> {
	const newContent = editContent[m.id];
	if (!newContent || newContent === m.content) return;
	const result = await updateMemory(m.id, { content: newContent }, "dashboard: corrected insight");
	if (result.success) {
		actedIds = new Set([...actedIds, m.id]);
		toast("Memory corrected", "success");
	} else {
		toast(result.error ?? "Failed to save", "error");
	}
}

function handleRefresh(): void {
	displayOffset = (displayOffset + visibleCount) % Math.max(1, scoredPool.length);
}
</script>

<div class="insights-panel sig-panel">
	<div class="insights-header sig-panel-header">
		<span class="insights-title">SUGGESTED INSIGHTS</span>
		<div class="insights-header-right">
			<span class="insights-count">{displayCards.length} OF {scoredPool.length}</span>
			<button class="refresh-btn sig-switch" onclick={handleRefresh} title="Refresh suggestions">
				<RefreshCw class="refresh-icon" />
				<span>REFRESH</span>
			</button>
		</div>
	</div>

	{#if displayCards.length === 0}
		<div class="empty-state">
			<span>NO INSIGHTS TO CURATE</span>
		</div>
	{:else}
		<div class="insights-list" bind:this={listEl}>
			{#each displayCards as m, i (m.id)}
				<div class="insight-entry">
					<!-- Index + date row -->
					<div class="entry-top">
						<div class="entry-top-left">
							<span class="entry-idx">{String(i + 1).padStart(2, "0")}</span>
							<span
								class="entry-dot"
								style="background: {importanceColor(m.importance ?? 0.5)}"
								title="importance: {(m.importance ?? 0.5).toFixed(2)}"
							></span>
							<span class="entry-date">{formatDate(m.created_at)}</span>
						</div>
						{#if parseTags(m.tags).length > 0}
							<div class="entry-tags">
								{#each parseTags(m.tags).slice(0, 3) as tag}
									<span class="entry-tag">{tag}</span>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Content -->
					<p class="entry-content">{m.content}</p>

					<!-- Actions -->
					<div class="entry-actions">
						<button
							class="action-btn accept sig-switch"
							onclick={() => acceptMemory(m)}
						>PIN</button>
						<button
							class="action-btn reject sig-switch"
							onclick={() => rejectMemory(m)}
						>DISMISS</button>
						<Popover.Root>
							<Popover.Trigger>
								{#snippet child({ props })}
									<button
										{...props}
										class="action-btn edit sig-switch"
										onclick={() => initEdit(m)}
									>EDIT</button>
								{/snippet}
							</Popover.Trigger>
							<Popover.Content
								class="w-72 !bg-[var(--sig-surface-raised)] !border-[var(--sig-border-strong)]"
								side="bottom"
								align="start"
							>
								<div class="edit-popover">
									<span class="sig-eyebrow">Correct memory</span>
									<Textarea
										class="mt-2 min-h-[60px] text-[11px] font-[family-name:var(--font-mono)]
											bg-[var(--sig-bg)] border-[var(--sig-border)]
											text-[var(--sig-text)]"
										value={editContent[m.id] ?? m.content}
										oninput={(e) => {
											const target = e.currentTarget;
											if (target instanceof HTMLTextAreaElement) {
												editContent[m.id] = target.value;
											}
										}}
									/>
									<div class="flex justify-end gap-1 mt-1">
										<Popover.Close>
											{#snippet child({ props })}
												<button
													{...props}
													class="text-[10px] px-2 py-1 text-[var(--sig-text-muted)] hover:text-[var(--sig-text)]"
												>Cancel</button>
											{/snippet}
										</Popover.Close>
										<Button
											variant="default"
											size="sm"
											class="text-[10px] h-6"
											onclick={() => saveCorrection(m)}
										>
											Save
										</Button>
									</div>
								</div>
							</Popover.Content>
						</Popover.Root>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.insights-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--sig-surface);
	}

	/* --- Header --- */
	.insights-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.insights-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.insights-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.insights-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.refresh-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		cursor: pointer;
	}

	:global(.insights-panel .refresh-icon) {
		width: 10px;
		height: 10px;
	}

	/* --- List --- */
	.insights-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.insight-entry {
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		display: flex;
		flex-direction: column;
		gap: 6px;
		transition: background var(--dur) var(--ease);
	}

	.insight-entry:last-child {
		border-bottom: none;
	}

	.insight-entry:hover {
		background: var(--sig-surface-raised);
	}

	/* --- Entry top row --- */
	.entry-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.entry-top-left {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.entry-idx {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-highlight);
		opacity: 0.4;
		font-variant-numeric: tabular-nums;
	}

	.entry-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.entry-date {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.entry-tags {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}

	.entry-tag {
		font-family: var(--font-mono);
		font-size: 8px;
		padding: 1px 6px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 2px;
		color: var(--sig-accent);
		letter-spacing: 0.04em;
	}

	/* --- Content --- */
	.entry-content {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.6;
		color: var(--sig-text);
		margin: 0;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* --- Actions --- */
	.entry-actions {
		display: flex;
		gap: 4px;
	}

	.action-btn {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		padding: 2px 8px;
		color: var(--sig-text-muted);
		cursor: pointer;
	}

	.action-btn.accept:hover {
		color: var(--sig-success);
		border-color: var(--sig-success);
	}

	.action-btn.reject:hover {
		color: var(--sig-danger);
		border-color: var(--sig-danger);
	}

	.action-btn.edit:hover {
		color: var(--sig-accent-hover);
		border-color: var(--sig-accent);
	}

	/* --- Empty state --- */
	.empty-state {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	/* --- Edit popover --- */
	.edit-popover {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
</style>
