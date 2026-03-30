<script lang="ts">
import { type MarkdownDoc, fetchChangelog, fetchReadme, fetchRoadmap } from "$lib/api";
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "$lib/components/ui/card/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import ExternalLink from "@lucide/svelte/icons/external-link";
import Github from "@lucide/svelte/icons/github";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import { onMount } from "svelte";

type ViewId = "readme" | "roadmap" | "changelog";

let readme = $state<MarkdownDoc | null>(null);
let roadmap = $state<MarkdownDoc | null>(null);
let changelog = $state<MarkdownDoc | null>(null);
let activeView = $state<ViewId>("roadmap");
let loading = $state(true);
let error = $state(false);

function docFor(view: ViewId): MarkdownDoc | null {
	if (view === "readme") return readme;
	if (view === "roadmap") return roadmap;
	return changelog;
}

function chooseActiveView(): void {
	if (docFor(activeView)) return;
	if (roadmap) {
		activeView = "roadmap";
		return;
	}
	if (changelog) {
		activeView = "changelog";
		return;
	}
	if (readme) activeView = "readme";
}

async function load(): Promise<void> {
	loading = true;
	error = false;

	const [readmeResult, roadmapResult, changelogResult] = await Promise.allSettled([
		fetchReadme(),
		fetchRoadmap(),
		fetchChangelog(),
	]);

	readme = readmeResult.status === "fulfilled" ? readmeResult.value : null;
	roadmap = roadmapResult.status === "fulfilled" ? roadmapResult.value : null;
	changelog = changelogResult.status === "fulfilled" ? changelogResult.value : null;

	error = !readme && !roadmap && !changelog;
	chooseActiveView();
	loading = false;
}

onMount(() => {
	void load();
});

function sourceLabel(doc: MarkdownDoc | null): string {
	if (!doc) return "";
	const ago = Math.round((Date.now() - doc.cachedAt) / 1000 / 60);
	const src = doc.source === "github" ? "github" : "local copy";
	return ago < 1 ? `${src} · just now` : `${src} · ${ago}m ago`;
}

function eyebrowFor(view: ViewId): string {
	if (view === "readme") return "OVERVIEW";
	if (view === "roadmap") return "PLANNING";
	return "RELEASES";
}

function titleFor(view: ViewId): string {
	if (view === "readme") return "README";
	if (view === "roadmap") return "Roadmap";
	return "Changelog";
}

function descriptionFor(view: ViewId): string {
	if (view === "readme") return "Short overview pulled from README.md.";
	if (view === "roadmap") return "Current priorities and planned work.";
	return "Recent released changes from CHANGELOG.md.";
}

function hrefFor(view: ViewId): string {
	if (view === "readme") {
		return "https://github.com/Signet-AI/signetai/blob/main/README.md";
	}
	if (view === "roadmap") {
		return "https://github.com/Signet-AI/signetai/blob/main/ROADMAP.md";
	}
	return "https://github.com/Signet-AI/signetai/blob/main/CHANGELOG.md";
}

const loadedDocs = $derived([readme, roadmap, changelog].filter(Boolean).length);
const activeDoc = $derived(docFor(activeView));
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	<PageBanner title="Changelog" />
	<div
		class="shrink-0 border-b border-[var(--sig-border)] bg-[var(--sig-surface)]
			px-4 py-3"
	>
		<div class="flex items-start gap-3">
			<div class="min-w-0">
				<div class="sig-heading text-[var(--sig-text-bright)]">Project</div>
				<p
					class="mt-1 max-w-2xl font-[family-name:var(--font-mono)] text-[11px]
						leading-5 text-[var(--sig-text-muted)]"
				>
					Overview, roadmap, and changelog.
				</p>
			</div>

			<div class="ml-auto flex items-center gap-3">
				{#if !loading}
					<span class="sig-meta whitespace-nowrap text-[var(--sig-text-muted)]">
						{loadedDocs}/3 docs loaded
					</span>
				{/if}
				<button
					class="text-[var(--sig-text-muted)] transition-colors hover:text-[var(--sig-text)]"
					onclick={() => void load()}
					title="Refresh"
				>
					<RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
				</button>
			</div>
		</div>
	</div>

	<div class="flex-1 min-h-0 overflow-hidden px-4 py-4 md:px-5 md:py-5">
		{#if loading}
			<div class="hidden h-full min-h-0 gap-4 2xl:flex">
				<div class="w-[21rem] min-w-[21rem] border border-[var(--sig-border)] bg-[var(--sig-surface)] p-4">
					<Skeleton class="mb-3 h-3 w-24" />
					<Skeleton class="mb-2 h-5 w-40" />
					<Skeleton class="mb-4 h-4 w-52" />
					<div class="space-y-2">
						{#each Array(10) as _}
							<Skeleton class="h-4 w-full" />
						{/each}
					</div>
				</div>
				<div class="min-w-0 flex-1 border border-[var(--sig-border)] bg-[var(--sig-surface)] p-4">
					<Skeleton class="mb-3 h-3 w-24" />
					<Skeleton class="mb-2 h-5 w-44" />
					<Skeleton class="mb-4 h-4 w-56" />
					<div class="space-y-2">
						{#each Array(14) as _}
							<Skeleton class="h-4 w-full" />
						{/each}
					</div>
				</div>
				<div class="min-w-0 flex-1 border border-[var(--sig-border)] bg-[var(--sig-surface)] p-4">
					<Skeleton class="mb-3 h-3 w-24" />
					<Skeleton class="mb-2 h-5 w-44" />
					<Skeleton class="mb-4 h-4 w-56" />
					<div class="space-y-2">
						{#each Array(14) as _}
							<Skeleton class="h-4 w-full" />
						{/each}
					</div>
				</div>
			</div>

			<div class="flex h-full min-h-0 flex-col gap-3 2xl:hidden">
				<div class="flex gap-2 border-b border-[var(--sig-border)] pb-3">
					<Skeleton class="h-8 w-20" />
					<Skeleton class="h-8 w-24" />
					<Skeleton class="h-8 w-24" />
				</div>
				<div class="border border-[var(--sig-border)] bg-[var(--sig-surface)] p-4">
					<Skeleton class="mb-3 h-3 w-24" />
					<Skeleton class="mb-2 h-5 w-40" />
					<Skeleton class="mb-4 h-4 w-56" />
					<div class="space-y-2">
						{#each Array(16) as _}
							<Skeleton class="h-4 w-full" />
						{/each}
					</div>
				</div>
			</div>
		{:else if error}
			<div class="flex h-full min-h-0 items-center justify-center">
				<div
					class="border border-[var(--sig-border-strong)] bg-[var(--sig-surface)]
						px-6 py-5 text-center"
				>
					<div class="sig-heading text-[var(--sig-text-bright)]">Project Unavailable</div>
					<p
						class="mt-2 max-w-md font-[family-name:var(--font-mono)] text-[11px]
							leading-5 text-[var(--sig-text-muted)]"
					>
						Couldn&apos;t load README, roadmap, or changelog.
					</p>
					<button
						class="mt-4 text-[11px] uppercase tracking-[0.08em]
							font-[family-name:var(--font-mono)] text-[var(--sig-accent)]
							transition-opacity hover:opacity-80"
						onclick={() => void load()}
					>
						retry
					</button>
				</div>
			</div>
		{:else}
			<div class="hidden h-full min-h-0 gap-4 2xl:flex">
				<Card
					class="flex h-full w-[21rem] min-w-[21rem] flex-col overflow-hidden
						rounded-none border-[var(--sig-border-strong)] bg-[var(--sig-surface)]
						py-0 shadow-none"
				>
					<CardHeader class="border-b border-[var(--sig-border)] px-4 py-3">
						<div class="sig-micro text-[var(--sig-text-muted)]">{eyebrowFor("readme")}</div>
						<CardTitle
							class="font-display text-[13px] font-bold uppercase tracking-[0.12em]
								text-[var(--sig-text-bright)]"
						>
							{titleFor("readme")}
						</CardTitle>
						<CardDescription
							class="font-[family-name:var(--font-mono)] text-[11px] leading-5
								text-[var(--sig-text-muted)]"
						>
							{descriptionFor("readme")}
						</CardDescription>
						<CardAction class="flex items-center gap-3">
							{#if readme}
								<span
									class="sig-meta flex items-center gap-1 whitespace-nowrap
										text-[var(--sig-text-muted)]"
								>
									<Github class="size-3" />
									{sourceLabel(readme)}
								</span>
							{/if}
							<a
								class="sig-meta flex items-center gap-1 whitespace-nowrap
									text-[var(--sig-accent)] transition-opacity hover:opacity-80"
								href={hrefFor("readme")}
								rel="noopener noreferrer"
								target="_blank"
							>
								<ExternalLink class="size-3" />
								source
							</a>
						</CardAction>
					</CardHeader>

					<CardContent class="flex-1 min-h-0 overflow-y-auto px-4 py-4">
						{#if readme}
							<div class="doc-body doc-body-overview">
								{@html readme.html}
							</div>
						{:else}
							<div class="doc-empty">README unavailable.</div>
						{/if}
					</CardContent>
				</Card>

				<Card
					class="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none
						border-[var(--sig-border-strong)] bg-[var(--sig-surface)] py-0
						shadow-none"
				>
					<CardHeader class="border-b border-[var(--sig-border)] px-4 py-3">
						<div class="sig-micro text-[var(--sig-text-muted)]">{eyebrowFor("roadmap")}</div>
						<CardTitle
							class="font-display text-[13px] font-bold uppercase tracking-[0.12em]
								text-[var(--sig-text-bright)]"
						>
							{titleFor("roadmap")}
						</CardTitle>
						<CardDescription
							class="font-[family-name:var(--font-mono)] text-[11px] leading-5
								text-[var(--sig-text-muted)]"
						>
							{descriptionFor("roadmap")}
						</CardDescription>
						<CardAction class="flex items-center gap-3">
							{#if roadmap}
								<span
									class="sig-meta flex items-center gap-1 whitespace-nowrap
										text-[var(--sig-text-muted)]"
								>
									<Github class="size-3" />
									{sourceLabel(roadmap)}
								</span>
							{/if}
							<a
								class="sig-meta flex items-center gap-1 whitespace-nowrap
									text-[var(--sig-accent)] transition-opacity hover:opacity-80"
								href={hrefFor("roadmap")}
								rel="noopener noreferrer"
								target="_blank"
							>
								<ExternalLink class="size-3" />
								source
							</a>
						</CardAction>
					</CardHeader>

					<CardContent class="flex-1 min-h-0 overflow-y-auto px-4 py-4">
						{#if roadmap}
							<div class="doc-body">
								{@html roadmap.html}
							</div>
						{:else}
							<div class="doc-empty">Roadmap unavailable.</div>
						{/if}
					</CardContent>
				</Card>

				<Card
					class="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-none
						border-[var(--sig-border-strong)] bg-[var(--sig-surface)] py-0
						shadow-none"
				>
					<CardHeader class="border-b border-[var(--sig-border)] px-4 py-3">
						<div class="sig-micro text-[var(--sig-text-muted)]">{eyebrowFor("changelog")}</div>
						<CardTitle
							class="font-display text-[13px] font-bold uppercase tracking-[0.12em]
								text-[var(--sig-text-bright)]"
						>
							{titleFor("changelog")}
						</CardTitle>
						<CardDescription
							class="font-[family-name:var(--font-mono)] text-[11px] leading-5
								text-[var(--sig-text-muted)]"
						>
							{descriptionFor("changelog")}
						</CardDescription>
						<CardAction class="flex items-center gap-3">
							{#if changelog}
								<span
									class="sig-meta flex items-center gap-1 whitespace-nowrap
										text-[var(--sig-text-muted)]"
								>
									<Github class="size-3" />
									{sourceLabel(changelog)}
								</span>
							{/if}
							<a
								class="sig-meta flex items-center gap-1 whitespace-nowrap
									text-[var(--sig-accent)] transition-opacity hover:opacity-80"
								href={hrefFor("changelog")}
								rel="noopener noreferrer"
								target="_blank"
							>
								<ExternalLink class="size-3" />
								source
							</a>
						</CardAction>
					</CardHeader>

					<CardContent class="flex-1 min-h-0 overflow-y-auto px-4 py-4">
						{#if changelog}
							<div class="doc-body">
								{@html changelog.html}
							</div>
						{:else}
							<div class="doc-empty">Changelog unavailable.</div>
						{/if}
					</CardContent>
				</Card>
			</div>

			<div class="flex h-full min-h-0 flex-col gap-3 2xl:hidden">
				<div
					class="flex shrink-0 gap-px border border-[var(--sig-border)]
						bg-[var(--sig-surface)] p-px"
				>
					<button
						class="updates-tab {activeView === 'readme' ? 'updates-tab-active' : ''}"
						onclick={() => (activeView = "readme")}
					>
						README
					</button>
					<button
						class="updates-tab {activeView === 'roadmap' ? 'updates-tab-active' : ''}"
						onclick={() => (activeView = "roadmap")}
					>
						ROADMAP
					</button>
					<button
						class="updates-tab {activeView === 'changelog' ? 'updates-tab-active' : ''}"
						onclick={() => (activeView = "changelog")}
					>
						CHANGELOG
					</button>
				</div>

				<Card
					class="flex h-full min-h-0 flex-col overflow-hidden rounded-none
						border-[var(--sig-border-strong)] bg-[var(--sig-surface)] py-0
						shadow-none"
				>
					<CardHeader class="border-b border-[var(--sig-border)] px-4 py-3">
						<div class="sig-micro text-[var(--sig-text-muted)]">{eyebrowFor(activeView)}</div>
						<CardTitle
							class="font-display text-[13px] font-bold uppercase tracking-[0.12em]
								text-[var(--sig-text-bright)]"
						>
							{titleFor(activeView)}
						</CardTitle>
						<CardDescription
							class="font-[family-name:var(--font-mono)] text-[11px] leading-5
								text-[var(--sig-text-muted)]"
						>
							{descriptionFor(activeView)}
						</CardDescription>
						<CardAction class="flex items-center gap-3">
							{#if activeDoc}
								<span
									class="sig-meta flex items-center gap-1 whitespace-nowrap
										text-[var(--sig-text-muted)]"
								>
									<Github class="size-3" />
									{sourceLabel(activeDoc)}
								</span>
							{/if}
							<a
								class="sig-meta flex items-center gap-1 whitespace-nowrap
									text-[var(--sig-accent)] transition-opacity hover:opacity-80"
								href={hrefFor(activeView)}
								rel="noopener noreferrer"
								target="_blank"
							>
								<ExternalLink class="size-3" />
								source
							</a>
						</CardAction>
					</CardHeader>

					<CardContent class="flex-1 min-h-0 overflow-y-auto px-4 py-4">
						{#if activeDoc}
							<div class="doc-body {activeView === 'readme' ? 'doc-body-overview' : ''}">
								{@html activeDoc.html}
							</div>
						{:else}
							<div class="doc-empty">{titleFor(activeView)} unavailable.</div>
						{/if}
					</CardContent>
				</Card>
			</div>
		{/if}
	</div>
</div>

<style>
	.updates-tab {
		flex: 1;
		border: 0;
		background: transparent;
		padding: 0.55rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		transition: color var(--dur), background-color var(--dur);
	}

	.updates-tab:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-text);
	}

	.updates-tab-active {
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
	}

	.doc-body {
		max-width: none;
	}

	.doc-body :global(h1) {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--sig-text-bright);
		margin-bottom: var(--space-sm);
	}

	.doc-body :global(h2) {
		font-family: var(--font-display);
		font-size: 0.85rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
		margin-top: var(--space-lg);
		margin-bottom: var(--space-sm);
		padding-bottom: var(--space-xs);
		border-bottom: 1px solid var(--sig-border);
	}

	.doc-body :global(h3) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text);
		margin-top: var(--space-md);
		margin-bottom: var(--space-xs);
	}

	.doc-body :global(p) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		line-height: 1.8;
		color: var(--sig-text-muted);
		margin-bottom: var(--space-sm);
	}

	.doc-body :global(ul) {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		line-height: 1.75;
		color: var(--sig-text-muted);
		padding-left: 1.15rem;
		margin-bottom: var(--space-sm);
	}

	.doc-body :global(li) {
		margin-bottom: 0.35rem;
	}

	.doc-body :global(code) {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		background: var(--sig-surface-raised);
		color: var(--sig-text-bright);
		padding: 1px 4px;
		border: 1px solid var(--sig-border);
	}

	.doc-body :global(strong) {
		color: var(--sig-text);
		font-weight: 600;
	}

	.doc-body :global(em) {
		color: var(--sig-text);
	}

	.doc-body :global(hr) {
		border: 0;
		border-top: 1px solid var(--sig-border);
		margin: var(--space-lg) 0;
	}

	.doc-body :global(a) {
		color: var(--sig-accent);
		text-decoration: none;
	}

	.doc-body :global(a:hover) {
		text-decoration: underline;
	}

	.doc-body-overview :global(h1) {
		margin-bottom: var(--space-xs);
	}

	.doc-body-overview :global(h2:first-of-type) {
		margin-top: 0;
	}

	.doc-empty {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		line-height: 1.7;
		color: var(--sig-text-muted);
	}
</style>
