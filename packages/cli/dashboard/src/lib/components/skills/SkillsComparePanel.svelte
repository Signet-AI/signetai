<script lang="ts">
import type { SkillSearchResult } from "$lib/api";
import { computePermissionFootprint } from "$lib/skills/risk-profile";

type Props = {
	items: SkillSearchResult[];
	onRemove: (key: string) => void;
	onClear: () => void;
};

let { items, onRemove, onClear }: Props = $props();

function itemKey(item: SkillSearchResult): string {
	return item.fullName;
}

function formatCount(value: number | undefined): string {
	if (value === undefined) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function maintainerLabel(item: SkillSearchResult): string {
	if (item.maintainer) return item.maintainer;
	if (item.author) return item.author;
	return item.fullName.split("@")[0] || "unknown";
}

function verifiedLabel(item: SkillSearchResult): string {
	if (item.verified === true) return "Verified";
	if (item.verified === false) return "Unverified";
	return "Unknown";
}
</script>

<div class="compare-wrap">
	<div class="compare-head">
		<p class="compare-title">Compare Skills ({items.length}/3)</p>
		<button type="button" class="clear-btn" onclick={onClear}>Clear</button>
	</div>
	<div class="compare-table-wrap">
		<table class="compare-table">
			<thead>
				<tr>
					<th>Skill</th>
					<th>Maintainer</th>
					<th>Stars/Downloads</th>
					<th>Verified</th>
					<th>Permissions</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each items as item (itemKey(item))}
					<tr>
						<td>{item.name}</td>
						<td>{maintainerLabel(item)}</td>
						<td>{formatCount(item.stars)} / {formatCount(item.downloads ?? item.installsRaw)}</td>
						<td>{verifiedLabel(item)}</td>
						<td>{computePermissionFootprint(item.permissions)}</td>
						<td>
							<button type="button" class="row-remove" onclick={() => onRemove(itemKey(item))}>
								Remove
							</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.compare-wrap {
		padding: 10px var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.compare-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.compare-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.clear-btn,
	.row-remove {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 3px 6px;
		border: 1px solid var(--sig-border-strong);
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
	}

	.clear-btn:hover,
	.row-remove:hover {
		color: var(--sig-text-bright);
		border-color: var(--sig-accent);
	}

	.compare-table-wrap {
		overflow-x: auto;
	}

	.compare-table {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
	}

	.compare-table th,
	.compare-table td {
		text-align: left;
		padding: 5px 6px;
		border-bottom: 1px solid var(--sig-border);
		white-space: nowrap;
	}

	.compare-table th {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}
</style>
