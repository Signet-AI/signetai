<script lang="ts">
import { onMount } from "svelte";
import {
	sk,
	fetchInstalled,
	fetchCatalog,
	setQuery,
	openDetail,
	doInstall,
	doUninstall,
	closeDetail,
	type SkillsView,
} from "$lib/stores/skills.svelte";
import SkillsTable from "$lib/components/skills/SkillsTable.svelte";
import SkillDetail from "$lib/components/skills/SkillDetail.svelte";
import * as Tabs from "$lib/components/ui/tabs/index.js";

let searchInput = $state<HTMLInputElement | null>(null);

function switchView(v: SkillsView) {
	sk.view = v;
	if (v === "all-time") fetchCatalog();
	if (v === "search") {
		requestAnimationFrame(() => searchInput?.focus());
	}
}

function handleGlobalKey(e: KeyboardEvent) {
	const target = e.target as HTMLElement;
	const isInput =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	if (e.key === "/" && !isInput) {
		e.preventDefault();
		switchView("search");
		return;
	}
	if (e.key === "Escape") {
		if (sk.detailOpen) {
			e.preventDefault();
			closeDetail();
			return;
		}
	}
}

onMount(() => {
	fetchInstalled();
});
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="h-full flex flex-col overflow-hidden">
	<!-- Hero header -->
	<div
		class="shrink-0 px-[var(--space-md)] pt-[var(--space-md)]
			pb-[var(--space-sm)] flex items-start gap-6
			border-b border-[var(--sig-border)]"
	>
		<div class="flex flex-col gap-1 shrink-0">
			<h1 class="absolute hidden">Skills</h1>
			<div class="relative max-w-[260px] overflow-hidden">
				<pre
					class="skills-ascii m-0 text-[var(--sig-text-muted)]
						select-none whitespace-pre"
					aria-hidden="true"
				>███████╗██╗  ██╗██╗██╗     ██╗     ███████╗
██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝
███████╗█████╔╝ ██║██║     ██║     ███████╗
╚════██║██╔═██╗ ██║██║     ██║     ╚════██║
███████║██║  ██╗██║███████╗███████╗███████║
╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝</pre>
				<pre
					class="skills-ascii absolute top-0 left-0 m-0
						text-[var(--sig-text-bright)] select-none whitespace-pre"
					aria-label="SKILLS"
				>███████ ██   ██ ██ ██      ██      ███████
██      ██  ██  ██ ██      ██      ██
███████ █████   ██ ██      ██      ███████
     ██ ██  ██  ██ ██      ██           ██
███████ ██   ██ ██ ███████ ███████ ███████
{' '}</pre>
			</div>
			<span
				class="font-[family-name:var(--font-mono)] text-[10px]
					font-medium text-[var(--sig-text)]
					uppercase tracking-[0.12em]"
			>
				The open agent skills ecosystem
			</span>
		</div>
		<div class="flex flex-col gap-2 pt-[2px]">
			<p
				class="text-[12px] text-[var(--sig-text)] leading-[1.5] m-0
					max-w-[460px]"
			>
				Skills are reusable capabilities for AI agents.
				Install them with a single command to enhance
				your agents with access to procedural knowledge.
			</p>
			<div class="flex items-center gap-3 flex-wrap">
				<a
					href="https://skills.sh"
					target="_blank"
					rel="noopener"
					class="font-[family-name:var(--font-mono)] text-[10px]
						text-[var(--sig-text-muted)]
						hover:text-[var(--sig-accent)] no-underline"
				>
					skills.sh
				</a>
				<span class="text-[var(--sig-border-strong)]">|</span>
				<span
					class="font-[family-name:var(--font-mono)] text-[10px]
						text-[var(--sig-text-muted)]"
				>
					by <a
						href="https://vercel.com/labs"
						target="_blank"
						rel="noopener"
						class="text-[var(--sig-text-muted)]
							hover:text-[var(--sig-accent)] no-underline"
					>Vercel Labs</a>
				</span>
				<span class="text-[var(--sig-border-strong)]">|</span>
				<a
					href="https://socket.dev/blog/socket-brings-supply-chain-security-to-skills"
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-[5px]
						font-[family-name:var(--font-mono)] text-[10px]
						text-[var(--sig-success)] no-underline
						hover:underline"
				>
					<svg width="10" height="10" viewBox="0 0 16 16" fill="none"
						class="shrink-0"
					>
						<path
							d="M8 0L10 5.5L16 6L11.5 10L13 16L8 12.5L3 16L4.5 10L0 6L6 5.5L8 0Z"
							fill="currentColor"
						/>
					</svg>
					Verified by Socket.dev
				</a>
			</div>
		</div>
	</div>

	<!-- Tabs bar -->
	<Tabs.Root value={sk.view} onValueChange={(v) => switchView(v as SkillsView)}>
		<div class="flex items-center shrink-0 border-b border-[var(--sig-border)]">
			<Tabs.List class="bg-transparent h-auto gap-0 rounded-none border-none">
				<Tabs.Trigger
					value="installed"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					Installed ({sk.installed.length})
				</Tabs.Trigger>
				<Tabs.Trigger
					value="all-time"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					All Time{sk.catalogTotal ? ` (${sk.catalogTotal.toLocaleString()})` : ""}
				</Tabs.Trigger>
				<Tabs.Trigger
					value="search"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					Search
				</Tabs.Trigger>
			</Tabs.List>

			{#if sk.view === "search"}
				<div class="flex-1 relative mx-[var(--space-sm)]">
					<input
						bind:this={searchInput}
						type="text"
						class="w-full px-3 py-[5px]
							border border-[var(--sig-border-strong)]
							bg-[var(--sig-surface-raised)]
							text-[var(--sig-text-bright)] text-[11px]
							font-[family-name:var(--font-mono)]
							outline-none focus:border-[var(--sig-accent)]
							pr-8"
						value={sk.query}
						oninput={(e) => setQuery(e.currentTarget.value)}
						placeholder="Search skills.sh..."
					/>
					<kbd
						class="absolute right-2 top-1/2 -translate-y-1/2
							px-[5px] py-px text-[9px]
							text-[var(--sig-text-muted)]
							bg-[var(--sig-bg)]
							border border-[var(--sig-border)]
							pointer-events-none"
					>/</kbd>
				</div>
			{/if}
		</div>
	</Tabs.Root>

	<!-- Content -->
	{#if sk.view === "installed"}
		{#if sk.loading}
			<div
				class="flex-1 flex items-center justify-center
					text-[var(--sig-text-muted)] text-[12px]"
			>
				Loading skills...
			</div>
		{:else}
			<SkillsTable
				items={sk.installed}
				mode="installed"
				selectedName={sk.selectedName}
				uninstalling={sk.uninstalling}
				onrowclick={(name) => openDetail(name)}
				onuninstall={(name) => doUninstall(name)}
			/>
		{/if}
	{:else if sk.view === "all-time"}
		{#if sk.catalogLoading}
			<div
				class="flex-1 flex items-center justify-center
					text-[var(--sig-text-muted)] text-[12px]"
			>
				Loading catalog...
			</div>
		{:else}
			<SkillsTable
				items={sk.catalog}
				mode="search"
				selectedName={sk.selectedName}
				installing={sk.installing}
				uninstalling={sk.uninstalling}
				onrowclick={(name) => openDetail(name)}
				oninstall={(name) => doInstall(name)}
				onuninstall={(name) => doUninstall(name)}
			/>
		{/if}
	{:else}
		{#if sk.searching}
			<div
				class="flex-1 flex items-center justify-center
					text-[var(--sig-text-muted)] text-[12px]"
			>
				Searching...
			</div>
		{:else if sk.results.length > 0}
			<SkillsTable
				items={sk.results}
				mode="search"
				selectedName={sk.selectedName}
				installing={sk.installing}
				uninstalling={sk.uninstalling}
				onrowclick={(name) => openDetail(name)}
				oninstall={(name) => doInstall(name)}
				onuninstall={(name) => doUninstall(name)}
			/>
		{:else if sk.query.trim()}
			<div
				class="flex-1 flex items-center justify-center
					text-[var(--sig-text-muted)] text-[12px]"
			>
				No results found.
			</div>
		{:else}
			<div
				class="flex-1 flex items-center justify-center
					text-[var(--sig-text-muted)] text-[12px]"
			>
				Type to search skills.sh
			</div>
		{/if}
	{/if}
</div>

<!-- Detail sheet -->
<SkillDetail />

<style>
	.skills-ascii {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: -1px;
		line-height: 125%;
	}
</style>
