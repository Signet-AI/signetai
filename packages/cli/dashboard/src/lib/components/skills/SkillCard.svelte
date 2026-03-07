<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";

type Props = {
	item: Skill | SkillSearchResult;
	mode: "installed" | "browse";
	featured?: boolean;
	selected?: boolean;
	compareSelected?: boolean;
	installing?: boolean;
	uninstalling?: boolean;
	onclick?: () => void;
	oninstall?: () => void;
	onuninstall?: () => void;
	oncomparetoggle?: () => void;
};

let {
	item,
	mode,
	featured = false,
	selected = false,
	compareSelected = false,
	installing = false,
	uninstalling = false,
	onclick,
	oninstall,
	onuninstall,
	oncomparetoggle,
}: Props = $props();

function isSearchResult(
	i: Skill | SkillSearchResult,
): i is SkillSearchResult {
	return "installed" in i && "fullName" in i;
}

function isSkill(i: Skill | SkillSearchResult): i is Skill {
	return "path" in i || "builtin" in i;
}

function formatStat(n: number | undefined): string {
	if (n === undefined) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

const MONOGRAM_COLORS = [
	"var(--sig-icon-bg-1)",
	"var(--sig-icon-bg-2)",
	"var(--sig-icon-bg-3)",
	"var(--sig-icon-bg-4)",
	"var(--sig-icon-bg-5)",
	"var(--sig-icon-bg-6)",
];

function getMonogramBg(name: string): string {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
	return MONOGRAM_COLORS[Math.abs(hash) % MONOGRAM_COLORS.length] ?? MONOGRAM_COLORS[0];
}

function getMonogram(name: string): string {
	// Split on hyphens, underscores, dots, spaces
	const parts = name.split(/[-_.\s]+/).filter(Boolean);
	if (parts.length >= 2) {
		return (parts[0][0] + parts[1][0]).toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

let monogram = $derived(getMonogram(item.name));
let monogramBg = $derived(getMonogramBg(item.name));

let isInstalled = $derived(
	isSkill(item) ? true : isSearchResult(item) ? item.installed : false
);
</script>

<div class="card-wrap" class:selected class:featured>
	<button
		type="button"
		class="card"
		onclick={() => onclick?.()}
	>
		<!-- Header: monogram + name/badges row -->
		<div class="card-top">
			<div
				class="monogram"
				class:monogram-featured={featured}
				style="background: {monogramBg};"
			>
				{monogram}
			</div>
			<div class="card-header-content">
				<div class="card-header">
					<span class="card-name" class:card-name-featured={featured}>{item.name}</span>
					<div class="badge-row">
						{#if mode === "browse" && isSearchResult(item)}
							<span
								class="compare-toggle"
								role="checkbox"
								aria-checked={compareSelected}
								tabindex="0"
								onclick={(e) => {
									e.stopPropagation();
									oncomparetoggle?.();
								}}
								onkeydown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										e.stopPropagation();
										oncomparetoggle?.();
									}
								}}
							>
								<span class="compare-dot" class:active={compareSelected}></span>
								<span>Compare</span>
							</span>
						{/if}
						{#if isSearchResult(item) && item.provider}
							<span
								class="provider-badge"
								class:clawhub={item.provider === "clawhub"}
							>
								{item.provider}
							</span>
						{/if}
					</div>
				</div>
			</div>
		</div>

		<!-- Description -->
		<p class="card-desc">
			{#if isSearchResult(item) && item.description}
				{item.description}
			{:else if isSkill(item) && item.description}
				{item.description}
			{:else if isSearchResult(item)}
				{item.fullName.split("@")[0]}
			{:else}
				&nbsp;
			{/if}
		</p>

		<!-- Stats row -->
		<div class="card-stats">
			{#if isSearchResult(item)}
				<span class="stat" title="Downloads">
					<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="shrink-0">
						<path d="M8 12L3 7h3V1h4v6h3L8 12zM2 14h12v1H2v-1z"/>
					</svg>
					{item.installs}
				</span>
				{#if item.stars !== undefined && item.stars > 0}
					<span class="stat" title="Stars">
						<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="shrink-0">
							<path d="M8 0L10 5.5L16 6L11.5 10L13 16L8 12.5L3 16L4.5 10L0 6L6 5.5L8 0Z"/>
						</svg>
						{formatStat(item.stars)}
					</span>
				{/if}
				{#if item.versions !== undefined && item.versions > 0}
					<span class="stat" title="Versions">
						v{item.versions}
					</span>
				{/if}
			{:else if isSkill(item)}
				{#if item.user_invocable}
					<span class="stat">/{item.name}</span>
				{/if}
				{#if item.builtin}
					<Badge variant="outline" class="rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">Built-in</Badge>
				{/if}
			{/if}
		</div>

		<!-- Action button (browse only) -->
		{#if mode === "browse" && isSearchResult(item)}
			<div class="card-action">
				<div class="action-row">
				{#if item.installed}
					<Button
						variant="outline"
						size="sm"
						class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
						onclick={(e: MouseEvent) => { e.stopPropagation(); onuninstall?.(); }}
						disabled={uninstalling}
					>
						{uninstalling ? "..." : "REMOVE"}
					</Button>
				{:else}
					<Button
						variant="outline"
						size="sm"
						class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text-bright)]"
						onclick={(e: MouseEvent) => { e.stopPropagation(); oninstall?.(); }}
						disabled={installing}
					>
						{installing ? "..." : "INSTALL"}
					</Button>
				{/if}
				</div>
			</div>
		{/if}
	</button>

	<!-- Hover-reveal remove for installed tab -->
	{#if mode === "installed" && isSkill(item) && !item.builtin}
		<button
			type="button"
			class="remove-corner"
			onclick={(e) => { e.stopPropagation(); onuninstall?.(); }}
			disabled={uninstalling}
			title="Uninstall"
		>
			{uninstalling ? "·" : "×"}
		</button>
	{/if}
</div>

<style>
	.card-wrap {
		position: relative;
		display: block;
		width: 100%;
	}
	.card-wrap:hover .remove-corner {
		opacity: 1;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: var(--space-sm);
		background:
			radial-gradient(circle at 12% -24%, color-mix(in srgb, var(--sig-accent) 8%, transparent), transparent 52%),
			linear-gradient(220deg, color-mix(in srgb, var(--sig-surface-raised) 92%, black) 0%, var(--sig-surface-raised) 72%);
		border: 1px solid var(--sig-border);
		cursor: pointer;
		transition: border-color 0.15s;
		text-align: left;
		min-height: 140px;
		width: 100%;
	}

	.card:hover {
		border-color: var(--sig-accent);
	}

	.card:focus-visible {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
		border-color: var(--sig-accent);
	}

	.action-row {
		display: flex;
		gap: 6px;
		width: 100%;
	}
	.card-wrap.selected > .card {
		border-color: var(--sig-accent);
		background:
			radial-gradient(circle at 12% -24%, color-mix(in srgb, var(--sig-accent) 10%, transparent), transparent 54%),
			linear-gradient(220deg, color-mix(in srgb, var(--sig-surface) 90%, black) 0%, var(--sig-surface) 74%);
	}
	.card-wrap.featured > .card {
		min-height: 160px;
	}

	.remove-corner {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 14px;
		line-height: 1;
		color: var(--sig-text-muted);
		background: transparent;
		border: none;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.1s, color 0.1s;
		padding: 0;
	}
	.remove-corner:hover {
		color: var(--sig-danger);
	}
	.remove-corner:disabled {
		cursor: default;
	}

	.card-top {
		display: flex;
		flex-direction: row;
		align-items: flex-start;
		gap: 8px;
	}

	.monogram {
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.45rem;
		border: 1px solid var(--sig-icon-border);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		color: var(--sig-icon-fg);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		user-select: none;
	}
	.monogram.monogram-featured {
		width: 34px;
		height: 34px;
		font-size: 11px;
	}

	.card-header-content {
		flex: 1;
		min-width: 0;
	}

	.card-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 6px;
		min-width: 0;
	}

	.badge-row {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.card-name {
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}
	.card-name.card-name-featured {
		font-size: 13px;
	}

	.provider-badge {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 9px;
		padding: 1px 5px;
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.provider-badge.clawhub {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
	}

	.card-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		line-height: 1.5;
		margin: 0;
		flex: 1;
		line-clamp: 3;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-stats {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.stat {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.card-action {
		margin-top: auto;
	}

	.compare-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		cursor: pointer;
		outline: none;
	}

	.compare-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border: 1px solid var(--sig-border-strong);
	}

	.compare-dot.active {
		background: var(--sig-accent);
		border-color: var(--sig-accent);
	}
</style>
