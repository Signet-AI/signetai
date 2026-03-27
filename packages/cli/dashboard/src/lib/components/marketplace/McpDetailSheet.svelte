<script lang="ts">
import type { MarketplaceMcpCatalogEntry, MarketplaceReview } from "$lib/api";
import { createMarketplaceReview, getMarketplaceReviews } from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { toast } from "$lib/stores/toast.svelte";
import ChevronDown from "@lucide/svelte/icons/chevron-down";

interface McpDetailItem {
	targetId: string;
	name: string;
	description: string;
	category: string;
	sourceLabel: string;
	official: boolean;
	popularityRank: number | null;
	sourceUrl: string;
	catalogEntry: MarketplaceMcpCatalogEntry | null;
	serverId: string | null;
}

interface Props {
	open: boolean;
	item: McpDetailItem | null;
	isInstalled: boolean;
	canReview: boolean;
	canInstall?: boolean;
	installBusy?: boolean;
	removeBusy?: boolean;
	onclose: () => void;
	oninstall?: (entry: MarketplaceMcpCatalogEntry) => void;
	onuninstall?: (serverId: string) => void;
}

const REVIEW_DISPLAY_NAME_KEY = "signet:marketplace:reviews:display-name";

type RatingValue = 1 | 2 | 3 | 4 | 5;
type ReviewFilter = "top" | "good" | "bad" | "all";

const {
	open,
	item,
	isInstalled,
	canReview,
	canInstall = true,
	installBusy = false,
	removeBusy = false,
	onclose,
	oninstall,
	onuninstall,
}: Props = $props();

let reviewFilter = $state<ReviewFilter>("top");
let reviewLoading = $state(false);
let reviewItems = $state<MarketplaceReview[]>([]);
let reviewsOpen = $state(true);

let displayName = $state(loadDisplayName());
let rating = $state<RatingValue>(5);
let title = $state("");
let body = $state("");
let submitting = $state(false);

const activeRatingLabel = $derived(`${rating}/5`);

const visibleReviews = $derived.by(() => {
	const items = [...reviewItems];
	if (reviewFilter === "top") {
		return items.sort((a, b) =>
			b.rating === a.rating
				? b.updatedAt.localeCompare(a.updatedAt)
				: b.rating - a.rating,
		);
	}
	if (reviewFilter === "good") {
		return items
			.filter((r) => r.rating >= 4)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	if (reviewFilter === "bad") {
		return items
			.filter((r) => r.rating <= 2)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

$effect(() => {
	if (!open || !item?.targetId) {
		reviewItems = [];
		return;
	}
	reviewFilter = "top";
	void loadReviews(item.targetId);
});

function loadDisplayName(): string {
	try {
		return localStorage.getItem(REVIEW_DISPLAY_NAME_KEY) ?? "";
	} catch {
		return "";
	}
}

function saveDisplayName(value: string): void {
	try {
		localStorage.setItem(REVIEW_DISPLAY_NAME_KEY, value);
	} catch {
		// ignore storage failures
	}
}

function parseRating(value: string): RatingValue {
	if (value === "1") return 1;
	if (value === "2") return 2;
	if (value === "3") return 3;
	if (value === "4") return 4;
	return 5;
}

async function loadReviews(targetId: string): Promise<void> {
	reviewLoading = true;
	try {
		const data = await getMarketplaceReviews({
			targetType: "mcp",
			targetId,
			limit: 100,
		});
		reviewItems = data.reviews;
	} finally {
		reviewLoading = false;
	}
}

async function submitReview(): Promise<void> {
	if (!item?.targetId) {
		return;
	}

	if (!canReview) {
		toast("Install or use this app before leaving a review.", "error");
		return;
	}

	const nextDisplayName = displayName.trim();
	const nextTitle = title.trim();
	const nextBody = body.trim();

	if (!nextDisplayName || !nextTitle || !nextBody) {
		toast("Display name, title, and review are required", "error");
		return;
	}

	submitting = true;
	try {
		const result = await createMarketplaceReview({
			targetType: "mcp",
			targetId: item.targetId,
			displayName: nextDisplayName,
			rating,
			title: nextTitle,
			body: nextBody,
		});

		if (!result.success) {
			toast(result.error ?? "Failed to submit review", "error");
			return;
		}

		saveDisplayName(nextDisplayName);
		title = "";
		body = "";
		toast("Review posted", "success");
		await loadReviews(item.targetId);
	} finally {
		submitting = false;
	}
}
</script>

<Sheet.Root {open} onOpenChange={(v) => { if (!v) onclose(); }}>
	<Sheet.Content
		side="right"
		showClose={false}
		class="!w-[520px] !max-w-[90vw] !bg-[var(--sig-surface)]
			!border-l !border-l-[var(--sig-border)] !p-0 flex flex-col"
	>
		<div class="detail-header">
			<div class="detail-title-wrap">
				<h2 class="detail-title">{item?.name ?? "Tool Server"}</h2>
				{#if item}
					<div class="detail-badges">
						<span class="detail-badge">{item.sourceLabel}</span>
						<span class="detail-badge">{item.category}</span>
						{#if item.official}
							<span class="detail-badge detail-badge-official">official</span>
						{/if}
						{#if item.popularityRank !== null}
							<span class="detail-rank">#{item.popularityRank}</span>
						{/if}
					</div>
				{/if}
			</div>

			{#if item}
				<div class="detail-action">
					{#if item.serverId}
						<Button
							variant="outline"
							size="sm"
							class="rounded-lg font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
							onclick={() => item.serverId && onuninstall?.(item.serverId)}
							disabled={removeBusy}
						>
							{removeBusy ? "..." : "Remove"}
						</Button>
					{:else if item.catalogEntry && canInstall}
						<Button
							variant="outline"
							size="sm"
							class="rounded-lg font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
							onclick={() => item.catalogEntry && oninstall?.(item.catalogEntry)}
							disabled={installBusy}
						>
							{installBusy ? "..." : "Install"}
						</Button>
					{:else if item.catalogEntry}
						<Button
							variant="outline"
							size="sm"
							class="rounded-lg font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-border-strong)] text-[var(--sig-text-muted)]"
							disabled={true}
							title="MCP installs are temporarily disabled"
						>
							Install disabled
						</Button>
					{/if}
				</div>
			{/if}
		</div>

		<div class="detail-body">
			{#if item}
				<p class="detail-description">{item.description || "No description available."}</p>
				{#if item.sourceUrl}
					<a class="detail-link" href={item.sourceUrl} target="_blank" rel="noopener">View source</a>
				{/if}

				<Collapsible.Root bind:open={reviewsOpen} class="reviews-section">
					<Collapsible.Trigger class="reviews-trigger">
						<span>Signet Reviews</span>
						<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${reviewsOpen ? "rotate-180" : ""}`} />
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="reviews-content">
							<div class="review-form">
						<Input
							class="review-input"
							placeholder="Display name"
							value={displayName}
							oninput={(e) => {
								displayName = e.currentTarget.value;
							}}
						/>

						<div class="review-row">
							<Select.Root
								type="single"
								value={String(rating)}
								onValueChange={(v) => {
									rating = parseRating(v ?? "5");
								}}
							>
								<Select.Trigger class="review-rating">{activeRatingLabel}</Select.Trigger>
								<Select.Content class="review-rating-content">
									<Select.Item value="5" label="5/5" class="review-rating-item" />
									<Select.Item value="4" label="4/5" class="review-rating-item" />
									<Select.Item value="3" label="3/5" class="review-rating-item" />
									<Select.Item value="2" label="2/5" class="review-rating-item" />
									<Select.Item value="1" label="1/5" class="review-rating-item" />
								</Select.Content>
							</Select.Root>
							<Input
								class="review-input"
								placeholder="Review title"
								value={title}
								oninput={(e) => {
									title = e.currentTarget.value;
								}}
							/>
						</div>

						<Textarea
							class="review-textarea"
							rows={3}
							placeholder="What worked? What should improve?"
							value={body}
							oninput={(e) => {
								body = e.currentTarget.value;
							}}
						/>
							<div class="review-actions">
								<span class="review-gate">Install or use this app before leaving a review.</span>
								<Button
								variant="outline"
								size="sm"
								class="review-submit"
								onclick={() => void submitReview()}
								disabled={submitting || !canReview}
							>
								{submitting ? "Posting..." : "Post review"}
							</Button>
							</div>
							</div>

							<div class="reviews-filters">
								<button class="review-filter" class:active={reviewFilter === "top"} onclick={() => (reviewFilter = "top")}>Top comments</button>
								<button class="review-filter" class:active={reviewFilter === "good"} onclick={() => (reviewFilter = "good")}>Good</button>
								<button class="review-filter" class:active={reviewFilter === "bad"} onclick={() => (reviewFilter = "bad")}>Bad</button>
								<button class="review-filter" class:active={reviewFilter === "all"} onclick={() => (reviewFilter = "all")}>All</button>
							</div>

							{#if reviewLoading}
								<p class="review-muted">Loading reviews...</p>
							{:else if visibleReviews.length === 0}
								<p class="review-muted">No reviews yet for this app.</p>
							{:else}
								<div class="review-list">
									{#each visibleReviews as review (review.id)}
										<article class="review-item">
											<div class="review-title">{review.title}</div>
											<div class="review-meta">{review.displayName} · {review.rating}/5</div>
											<p class="review-body">{review.body}</p>
										</article>
									{/each}
								</div>
							{/if}
						</div>
					</Collapsible.Content>
				</Collapsible.Root>
			{:else}
				<p class="review-muted">Select a server to view details.</p>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	.detail-header {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--sig-border);
	}

	.detail-title-wrap {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.detail-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 14px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail-badges {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.detail-badge,
	.detail-rank {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.detail-badge {
		border: 1px solid var(--sig-border-strong);
		padding: 2px 6px;
	}

	.detail-badge-official {
		border-color: color-mix(in srgb, var(--sig-success) 70%, var(--sig-border-strong));
		color: var(--sig-success);
	}

	.detail-action {
		flex-shrink: 0;
	}

	.detail-body {
		flex: 1;
		overflow-y: auto;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.detail-description,
	.review-muted,
	.review-meta,
	.review-body {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.45;
		color: var(--sig-text-muted);
	}

	.detail-link {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		text-decoration: none;
	}

	.detail-link:hover {
		text-decoration: underline;
	}

	:global(.reviews-section) {
		margin-top: 6px;
		padding-top: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		border-radius: 0.5rem;
	}

	:global(.reviews-trigger) {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		background: transparent;
		border: 0;
		cursor: pointer;
	}

	:global(.reviews-trigger span) {
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sig-text-bright);
	}

	.reviews-content {
		padding: 0 10px 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.reviews-filters {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.review-filter {
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 3px 7px;
		cursor: pointer;
	}

	.review-filter.active {
		color: var(--sig-text-bright);
		border-color: var(--sig-accent);
	}

	.review-form {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 8px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: 0.45rem;
	}

	:global(.review-input),
	:global(.review-textarea) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.review-row {
		display: grid;
		grid-template-columns: 92px minmax(0, 1fr);
		gap: 6px;
	}

	:global(.review-rating) {
		height: 32px;
		padding: 0 8px;
		font-family: var(--font-mono);
		font-size: 10px;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.45rem;
	}

	:global(.review-rating-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	:global(.review-rating-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.review-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.review-gate {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.4;
		color: var(--sig-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	:global(.review-submit) {
		height: 30px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.review-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.review-item {
		padding: 8px;
		background: var(--sig-surface-raised);
		border-radius: 0.45rem;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.review-title {
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sig-text-bright);
	}

	@media (max-width: 640px) {
		.review-row {
			grid-template-columns: 1fr;
		}

		.review-actions {
			align-items: flex-start;
			flex-direction: column;
		}

		.review-gate {
			white-space: normal;
		}
	}
</style>
