<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";

type Props = {
	items: Skill[] | SkillSearchResult[];
	mode: "installed" | "search";
	selectedName?: string | null;
	installing?: string | null;
	uninstalling?: string | null;
	onrowclick?: (name: string) => void;
	oninstall?: (name: string) => void;
	onuninstall?: (name: string) => void;
};

let {
	items,
	mode,
	selectedName = null,
	installing = null,
	uninstalling = null,
	onrowclick,
	oninstall,
	onuninstall,
}: Props = $props();

function isSearchResult(
	item: Skill | SkillSearchResult,
): item is SkillSearchResult {
	return "installed" in item && "fullName" in item;
}

function isSkill(item: Skill | SkillSearchResult): item is Skill {
	return "path" in item || "builtin" in item;
}
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-y-auto">
	{#each items as item, i}
		{@const active = selectedName === item.name}
		<button
			type="button"
			class="skill-row
				{active ? 'active' : ''}"
			onclick={() => onrowclick?.(item.name)}
		>
			<!-- Rank number -->
			<span class="skill-rank">{i + 1}</span>

			<!-- Name + subtitle -->
			<div class="flex flex-col gap-px flex-1 min-w-0">
				<span class="skill-name">{item.name}</span>
				<span class="skill-sub">
					{#if isSearchResult(item)}
						{item.fullName.split("@")[0]}
					{:else if isSkill(item) && item.description}
						{item.description}
					{:else if isSkill(item) && item.user_invocable}
						/{item.name}
					{:else}
						&nbsp;
					{/if}
				</span>
			</div>

			<!-- Right side: badges / counts / actions -->
			<div
				class="flex items-center gap-[6px] shrink-0"
				onclick={(e) => e.stopPropagation()}
			>
				{#if mode === "search" && isSearchResult(item)}
					<span class="skill-count">{item.installs}</span>
					{#if item.installed}
						<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] border-[var(--sig-success)] text-[var(--sig-success)]">Installed</Badge>
					{:else}
						<Button
							variant="outline"
							size="sm"
							class="h-auto rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
							onclick={(e: MouseEvent) => { e.stopPropagation(); oninstall?.(item.name); }}
							disabled={installing === item.name}
						>
							{installing === item.name ? "..." : "Install"}
						</Button>
					{/if}
				{:else if mode === "installed" && isSkill(item)}
					{#if item.builtin}
						<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">Built-in</Badge>
					{/if}
					{#if item.user_invocable}
						<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] border-[var(--sig-border-strong)] text-[var(--sig-text-muted)]">/{item.name}</Badge>
					{/if}
					{#if !item.builtin}
						<Button
							variant="outline"
							size="sm"
							class="h-auto rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
							onclick={(e: MouseEvent) => { e.stopPropagation(); onuninstall?.(item.name); }}
							disabled={uninstalling === item.name}
						>
							{uninstalling === item.name ? "..." : "Uninstall"}
						</Button>
					{/if}
				{/if}
			</div>
		</button>
	{/each}

	{#if items.length === 0}
		<div class="p-8 text-center text-[var(--sig-text-muted)] text-[12px]">
			{#if mode === "installed"}
				No skills installed. Search above to find skills.
			{:else}
				No results found.
			{/if}
		</div>
	{/if}
</div>

<style>
	.skill-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		text-align: left;
		padding: 6px var(--space-md);
		background: transparent;
		border: none;
		border-left: 2px solid transparent;
		cursor: pointer;
		transition: background 0.1s;
	}
	.skill-row:hover {
		background: var(--sig-surface-raised);
	}
	.skill-row.active {
		border-left-color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}

	.skill-rank {
		width: 24px;
		flex-shrink: 0;
		text-align: right;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.skill-name {
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.skill-sub {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.skill-count {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		font-variant-numeric: tabular-nums;
	}

</style>
