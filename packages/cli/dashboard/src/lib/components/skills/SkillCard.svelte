<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";
import { getMonogram, getMonogramBg } from "$lib/card-utils";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { getCatalogByName } from "$lib/stores/skills.svelte";

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


let monogram = $derived(getMonogram(item.name));
let monogramBg = $derived(getMonogramBg(item.name));

function getSkillAvatarUrl(): string | null {
	let maintainer: string | undefined;
	if (isSearchResult(item)) {
		maintainer = item.maintainer;
	} else {
		maintainer = getCatalogByName().get(item.name)?.maintainer;
	}
	if (maintainer) return `https://github.com/${maintainer.split("/")[0]}.png?size=40`;
	return null;
}

let avatarUrl = $derived(getSkillAvatarUrl());
let avatarFailed = $state(false);
$effect(() => { avatarUrl; avatarFailed = false; });

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
				style="background: {avatarUrl && !avatarFailed ? 'transparent' : monogramBg};"
			>
				{#if avatarUrl && !avatarFailed}
					<img
						src={avatarUrl}
						alt={item.name}
						class="monogram-avatar"
						onerror={() => { avatarFailed = true; }}
					/>
				{:else}
					{monogram}
				{/if}
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

		<!-- Action buttons -->
		{#if mode === "browse" && isSearchResult(item)}
			<div class="card-action">
				<div class="action-row">
				{#if item.installed}
					<Button
						variant="outline"
						size="sm"
						class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text)] transition-all duration-150 hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-danger)] hover:shadow-[0_0_12px_rgba(220,38,38,0.35)] hover:scale-[1.02]"
						onclick={(e: MouseEvent) => { e.stopPropagation(); onuninstall?.(); }}
						disabled={uninstalling}
					>
						{uninstalling ? "..." : "REMOVE"}
					</Button>
				{:else}
					<Button
						variant="outline"
						size="sm"
						class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text)] transition-all duration-150 hover:bg-[var(--sig-surface-raised)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-text-muted)] hover:shadow-[0_0_12px_rgba(255,255,255,0.1)] hover:scale-[1.02]"
						onclick={(e: MouseEvent) => { e.stopPropagation(); oninstall?.(); }}
						disabled={installing}
					>
						{installing ? "..." : "INSTALL"}
					</Button>
				{/if}
				</div>
			</div>
		{:else if mode === "installed" && isSkill(item) && !item.builtin}
			<div class="card-action">
				<div class="action-row">
					<Button
						variant="outline"
						size="sm"
						class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text)] transition-all duration-150 hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-danger)] hover:shadow-[0_0_12px_rgba(220,38,38,0.35)] hover:scale-[1.02]"
						onclick={(e: MouseEvent) => { e.stopPropagation(); onuninstall?.(); }}
						disabled={uninstalling}
					>
						{uninstalling ? "..." : "REMOVE"}
					</Button>
				</div>
			</div>
		{/if}
	</button>

</div>

<style>
	.card-wrap {
		position: relative;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: var(--space-sm);
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		cursor: pointer;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
		text-align: left;
		min-height: 0;
		width: 100%;
		flex: 1;
	}

	.card:hover {
		border-color: var(--sig-border-strong);
		background: var(--sig-surface-raised);
	}

	.card:focus-visible {
		outline: 2px solid var(--sig-highlight);
		outline-offset: 1px;
		border-color: var(--sig-highlight);
	}

	.action-row {
		display: flex;
		gap: 6px;
		width: 100%;
		margin-top: auto;
	}
	.card-wrap.selected > .card {
		border-color: var(--sig-highlight);
		border-left: 2px solid var(--sig-highlight);
		background: var(--sig-surface-raised);
	}
	.card-wrap.featured > .card {
		min-height: 0;
	}


	.card-top {
		display: flex;
		flex-direction: row;
		align-items: flex-start;
		gap: 8px;
	}

	.monogram {
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		border: 1px solid var(--sig-icon-border);
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 700;
		color: var(--sig-icon-fg);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		user-select: none;
		overflow: hidden;
	}

	.monogram-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.monogram.monogram-featured {
		width: 24px;
		height: 24px;
		font-size: 9px;
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
		font-family: var(--font-mono);
		font-size: 11px;
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
		font-size: 11px;
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
		font-size: 9px;
		color: var(--sig-text-muted);
		line-height: 1.5;
		margin: 0;
		min-height: calc(9px * 1.5 * 2);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-stats {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		min-height: 18px;
	}

	.stat {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-mono);
		font-size: 9px;
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
		background: var(--sig-highlight);
		border-color: var(--sig-highlight);
	}
</style>
