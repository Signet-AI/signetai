<script lang="ts">
import type { Memory } from "$lib/api";
import { setMemoryPinned, updateMemory } from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { toast } from "$lib/stores/toast.svelte";
import Check from "@lucide/svelte/icons/check";
import Pencil from "@lucide/svelte/icons/pencil";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import X from "@lucide/svelte/icons/x";

interface Props {
	memories: Memory[];
}

const { memories }: Props = $props();

let actedIds = $state<Set<string>>(new Set());
let refreshKey = $state(0);

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

const scoredPool = $derived.by(() => {
	void refreshKey;
	return memories
		.filter((m) => {
			if (actedIds.has(m.id)) return false;
			if (m.pinned) return false;
			const tags = parseTags(m.tags);
			if (tags.includes("rejected-insight")) return false;
			return true;
		})
		.map((m) => ({ memory: m, score: scoreMemory(m) }))
		.sort((a, b) => b.score - a.score);
});

const displayCards = $derived(scoredPool.slice(0, 3).map((s) => s.memory));

function importanceColor(imp: number): string {
	if (imp >= 0.8) return "var(--sig-danger)";
	if (imp >= 0.5) return "var(--sig-warning, #d4a017)";
	return "var(--sig-success)";
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
	refreshKey += 1;
}
</script>

<Card.Root class="flex flex-col h-full overflow-hidden">
	<Card.Header class="flex-row items-center justify-between py-2 px-3 shrink-0">
		<Card.Title>
			<span class="sig-heading">Suggested Insights</span>
		</Card.Title>
		<Button
			variant="ghost"
			size="sm"
			class="h-6 w-6 p-0"
			onclick={handleRefresh}
		>
			<RefreshCw class="size-3.5" />
		</Button>
	</Card.Header>
	<Card.Content class="flex-1 min-h-0 overflow-hidden px-3 pb-3">
		{#if displayCards.length === 0}
			<div class="flex items-center justify-center h-full">
				<span class="sig-label">No insights to curate</span>
			</div>
		{:else}
			<div class="insight-grid">
				{#each displayCards as m (m.id)}
					<div class="insight-card">
						<div class="insight-header">
							<span
								class="importance-dot"
								style="background: {importanceColor(m.importance ?? 0.5)}"
								title="importance: {(m.importance ?? 0.5).toFixed(2)}"
							></span>
							<span class="sig-micro">
								{new Date(m.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
							</span>
						</div>

						<p class="insight-content">{m.content}</p>

						{#if parseTags(m.tags).length > 0}
							<div class="insight-tags">
								{#each parseTags(m.tags).slice(0, 3) as tag}
									<span class="sig-badge tag-badge">{tag}</span>
								{/each}
							</div>
						{/if}

						<div class="insight-actions">
							<Button
								variant="ghost"
								size="sm"
								class="action-btn accept"
								onclick={() => acceptMemory(m)}
								title="Pin memory"
							>
								<Check class="size-3" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								class="action-btn reject"
								onclick={() => rejectMemory(m)}
								title="Dismiss"
							>
								<X class="size-3" />
							</Button>
							<Popover.Root>
								<Popover.Trigger>
									{#snippet child({ props })}
										<button
											{...props}
											class="action-btn-raw"
											onclick={() => initEdit(m)}
											title="Correct"
										>
											<Pencil class="size-3" />
										</button>
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
	</Card.Content>
</Card.Root>

<style>
	.insight-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: var(--space-sm);
		height: 100%;
	}

	.insight-card {
		padding: var(--space-sm);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-height: 0;
		overflow: hidden;
	}

	.insight-header {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-shrink: 0;
	}

	.importance-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.insight-content {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		line-height: 1.5;
		color: var(--sig-text);
		margin: 0;
		flex: 1;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		-webkit-box-orient: vertical;
	}

	.insight-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		flex-shrink: 0;
	}

	.tag-badge {
		font-size: 8px;
		padding: 1px 4px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		color: var(--sig-text-muted);
	}

	.insight-actions {
		display: flex;
		gap: 2px;
		margin-top: auto;
		flex-shrink: 0;
	}

	:global(.action-btn) {
		height: 22px !important;
		width: 22px !important;
		padding: 0 !important;
	}

	.action-btn-raw {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 22px;
		width: 22px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
		border-radius: var(--radius);
		transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.action-btn-raw:hover {
		color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}

	:global(.action-btn.accept:hover) {
		color: var(--sig-success) !important;
	}

	:global(.action-btn.reject:hover) {
		color: var(--sig-danger) !important;
	}

	.edit-popover {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
</style>
