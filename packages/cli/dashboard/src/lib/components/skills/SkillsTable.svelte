<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";

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
						<span class="badge badge-installed">Installed</span>
					{:else}
						<button
							type="button"
							class="btn-install"
							onclick={(e) => { e.stopPropagation(); oninstall?.(item.name); }}
							disabled={installing === item.name}
						>
							{installing === item.name ? "..." : "Install"}
						</button>
					{/if}
				{:else if mode === "installed" && isSkill(item)}
					{#if item.builtin}
						<span class="badge badge-builtin">Built-in</span>
					{/if}
					{#if item.user_invocable}
						<span class="badge badge-slash">/{item.name}</span>
					{/if}
					{#if !item.builtin}
						<button
							type="button"
							class="btn-uninstall"
							onclick={(e) => { e.stopPropagation(); onuninstall?.(item.name); }}
							disabled={uninstalling === item.name}
						>
							{uninstalling === item.name ? "..." : "Uninstall"}
						</button>
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

	.badge {
		font-family: var(--font-mono);
		font-size: 9px;
		padding: 1px 5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		border: 1px solid;
		white-space: nowrap;
	}
	.badge-installed {
		border-color: var(--sig-success);
		color: var(--sig-success);
	}
	.badge-builtin {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
	}
	.badge-slash {
		border-color: var(--sig-border-strong);
		color: var(--sig-text-muted);
	}

	.btn-install {
		padding: 2px 8px;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		background: transparent;
		border: 1px solid var(--sig-text-bright);
		color: var(--sig-text-bright);
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}
	.btn-install:hover:not(:disabled) {
		background: var(--sig-text-bright);
		color: var(--sig-bg);
	}
	.btn-install:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn-uninstall {
		padding: 2px 8px;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		background: transparent;
		border: 1px solid var(--sig-danger);
		color: var(--sig-danger);
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}
	.btn-uninstall:hover:not(:disabled) {
		background: var(--sig-danger);
		color: var(--sig-text-bright);
	}
	.btn-uninstall:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
