<script lang="ts">
import { invalidateAll } from "$app/navigation";
import type { ConfigFile } from "$lib/api";
import IdentityPanel from "$lib/components/config/IdentityPanel.svelte";
import { st } from "$lib/stores/settings.svelte";
import { setSettingsDirty } from "$lib/stores/unsaved-changes.svelte";
import { untrack } from "svelte";
import AgentSection from "./settings/AgentSection.svelte";
import AppearanceSection from "./settings/AppearanceSection.svelte";
import AuthSection from "./settings/AuthSection.svelte";
import EmbeddingsSection from "./settings/EmbeddingsSection.svelte";
import MemorySection from "./settings/MemorySection.svelte";
import NetworkSection from "./settings/NetworkSection.svelte";
import PipelineSection from "./settings/PipelineSection.svelte";
import SearchSection from "./settings/SearchSection.svelte";
import TrustSection from "./settings/TrustSection.svelte";

interface Props {
	configFiles: ConfigFile[];
}

const { configFiles }: Props = $props();

interface SectionDef {
	id: string;
	title: string;
	paths: string[][];
	source: "agent" | "config";
}

const sectionDefs: SectionDef[] = [
	{
		id: "agent",
		title: "Agent",
		source: "agent",
		paths: [["agent", "name"], ["agent", "description"], ["harnesses"]],
	},
	{
		id: "network",
		title: "Network",
		source: "agent",
		paths: [["network"]],
	},
	{
		id: "embeddings",
		title: "Embeddings",
		source: "config",
		paths: [["embedding"], ["memory", "embeddings"], ["embeddings"]],
	},
	{
		id: "memory",
		title: "Memory",
		source: "config",
		paths: [["memory", "session_budget"], ["memory", "current_md_budget"], ["memory", "decay_rate"], ["paths"]],
	},
	{
		id: "search",
		title: "Search",
		source: "config",
		paths: [["search"]],
	},
	{
		id: "pipeline",
		title: "Pipeline",
		source: "agent",
		paths: [["memory", "pipelineV2"]],
	},
	{
		id: "trust",
		title: "Trust",
		source: "agent",
		paths: [["trust"]],
	},
	{
		id: "auth",
		title: "Auth",
		source: "config",
		paths: [["auth"]],
	},
	{
		id: "appearance",
		title: "Appearance",
		source: "config",
		paths: [],
	},
];

const tabBtn =
	"px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] rounded-md transition-colors duration-150 border-none cursor-pointer whitespace-nowrap";
const tabActive = `${tabBtn} text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)] border border-[color-mix(in_srgb,var(--sig-highlight),transparent_85%)]`;
const tabInactive = `${tabBtn} bg-transparent text-[var(--sig-text-muted)] hover:text-[var(--sig-highlight)] hover:bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_94%)]`;

let activeSection = $state("agent");
let discardDialogOpen = $state(false);
let identityPanel = $state<IdentityPanel | null>(null);
let identityDirty = $state(false);

const sections = $derived(
	sectionDefs.map((def) => ({
		id: def.id,
		title: def.title,
		dirty: st.isAnyPathDirty(def.source, def.paths),
	})),
);

const combinedDirty = $derived(st.isDirty || identityDirty);

$effect(() => {
	const files = configFiles;
	untrack(() => st.init(files));
});

$effect(() => {
	setSettingsDirty(combinedDirty);
	return () => {
		setSettingsDirty(false);
	};
});

async function saveAll(): Promise<void> {
	const promises: Promise<void>[] = [];
	if (st.isDirty) promises.push(st.save());
	if (identityDirty && identityPanel) promises.push(identityPanel.save());
	await Promise.all(promises);
	// Refresh page-level configFiles so IdentityPanel gets fresh data
	await invalidateAll();
}

function handleDiscard(): void {
	discardDialogOpen = true;
}

function confirmDiscard(): void {
	st.reset();
	identityPanel?.discard();
	discardDialogOpen = false;
}

function handleGlobalKey(e: KeyboardEvent): void {
	if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		if (combinedDirty && !st.saving) saveAll();
		return;
	}
}

function formatSavedAt(raw: string | null): string {
	if (!raw) return "";
	try {
		return `Last saved ${new Date(raw).toLocaleTimeString()}`;
	} catch {
		return "";
	}
}
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="settings-tab">
	{#if !st.hasFiles}
		<div class="empty-state">No YAML config files found</div>
	{:else}
		<!-- Section tab bar -->
		<header class="tab-bar">
			<div class="tab-group">
				{#each sectionDefs as def (def.id)}
					<button
						class={activeSection === def.id ? tabActive : tabInactive}
						onclick={() => (activeSection = def.id)}
					>
						{def.title}
						{#if sections.find((s) => s.id === def.id)?.dirty}
							<span class="tab-dirty">&bull;</span>
						{/if}
					</button>
				{/each}
			</div>
		</header>

		<!-- Main content: settings + identity panel -->
		<div class="main-area">
			<div class="section-content">
				{#if activeSection === "agent"}
					<AgentSection />
				{:else if activeSection === "network"}
					<NetworkSection />
				{:else if activeSection === "embeddings"}
					<EmbeddingsSection />
				{:else if activeSection === "search"}
					<SearchSection />
				{:else if activeSection === "memory"}
					<MemorySection />
				{:else if activeSection === "pipeline"}
					<PipelineSection />
				{:else if activeSection === "trust"}
					<TrustSection />
				{:else if activeSection === "auth"}
					<AuthSection />
				{:else if activeSection === "appearance"}
					<AppearanceSection />
				{/if}
			</div>

			<IdentityPanel
				bind:this={identityPanel}
				{configFiles}
				onDirtyChange={(dirty) => (identityDirty = dirty)}
			/>
		</div>

		<!-- Unified save bar -->
		<footer class="save-bar">
			<div class="save-meta">
				<span class="save-state" class:dirty={combinedDirty}>
					{combinedDirty ? "Unsaved changes" : "All saved"}
				</span>
				{#if st.lastSavedAt}
					<span>{formatSavedAt(st.lastSavedAt)}</span>
				{/if}
			</div>
			{#if combinedDirty}
				<button type="button" class="discard-btn" onclick={handleDiscard} disabled={st.saving}>
					Discard
				</button>
			{/if}
			<button
				type="button"
				class="save-btn"
				onclick={saveAll}
				disabled={st.saving || !combinedDirty}
				title="Save (Ctrl+S)"
			>
				{st.saving ? "Saving..." : "Save"}
			</button>
		</footer>

		<!-- Discard confirmation dialog -->
		{#if discardDialogOpen}
			<div
				class="dialog-overlay"
				role="button"
				tabindex="0"
				aria-label="Close discard dialog"
				onclick={(e) => {
					if (e.currentTarget !== e.target) return;
					discardDialogOpen = false;
				}}
				onkeydown={(e) => {
					if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						discardDialogOpen = false;
					}
				}}
			>
				<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="discard-dialog-title">
					<div class="dialog-title" id="discard-dialog-title">Discard changes?</div>
					<div class="dialog-body">
						This will revert all unsaved changes to settings and identity files.
						This cannot be undone.
					</div>
					<div class="dialog-actions">
						<button type="button" class="dialog-btn cancel" onclick={() => discardDialogOpen = false}>
							Cancel
						</button>
						<button type="button" class="dialog-btn danger" onclick={confirmDiscard}>
							Discard
						</button>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.settings-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--sig-text-muted);
	}

	.tab-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2px var(--space-md) var(--space-sm);
		background: transparent;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.tab-group {
		display: flex;
		align-items: center;
		gap: 2px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 0.5rem;
		padding: 1px;
	}

	.tab-dirty {
		color: var(--sig-accent);
		margin-left: 2px;
	}

	.main-area {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.section-content {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow-y: auto;
	}

	.save-bar {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		justify-content: flex-end;
		padding: var(--space-sm) var(--space-md);
		background: var(--sig-surface);
		border-top: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.save-meta {
		margin-right: auto;
		display: flex;
		gap: var(--space-sm);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.save-state {
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.save-state.dirty {
		color: var(--sig-warning, #d4a017);
	}

	.discard-btn {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		background: transparent;
		border: 1px solid var(--sig-border);
		padding: 6px 16px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.discard-btn:hover {
		color: var(--sig-text);
		border-color: var(--sig-border-strong);
	}

	.save-btn {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-bg);
		background: var(--sig-text-bright);
		border: none;
		padding: 6px 20px;
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	.save-btn:disabled,
	.discard-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.save-btn:not(:disabled):hover {
		opacity: 0.85;
	}

	.dialog-overlay {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		z-index: 100;
	}

	.dialog {
		width: 360px;
		max-width: 90vw;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
	}

	.dialog-title {
		padding: 12px 16px;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-bright);
		border-bottom: 1px solid var(--sig-border);
	}

	.dialog-body {
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.6;
		color: var(--sig-text);
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 16px;
		border-top: 1px solid var(--sig-border);
	}

	.dialog-btn {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 6px 14px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.dialog-btn.cancel {
		color: var(--sig-text);
		background: transparent;
		border: 1px solid var(--sig-border);
	}

	.dialog-btn.cancel:hover {
		border-color: var(--sig-border-strong);
	}

	.dialog-btn.danger {
		color: var(--sig-bg);
		background: var(--sig-danger);
		border: 1px solid var(--sig-danger);
	}

	.dialog-btn.danger:hover {
		opacity: 0.85;
	}

	@media (max-width: 640px) {
		.tab-group {
			overflow-x: auto;
		}
	}
</style>
