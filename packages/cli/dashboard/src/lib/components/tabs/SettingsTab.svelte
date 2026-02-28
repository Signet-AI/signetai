<script lang="ts">
import type { ConfigFile } from "$lib/api";
import { st } from "$lib/stores/settings.svelte";
import { setSettingsDirty } from "$lib/stores/unsaved-changes.svelte";
import { untrack } from "svelte";
import AgentSection from "./settings/AgentSection.svelte";
import AuthSection from "./settings/AuthSection.svelte";
import EmbeddingsSection from "./settings/EmbeddingsSection.svelte";
import MemorySection from "./settings/MemorySection.svelte";
import PathsSection from "./settings/PathsSection.svelte";
import PipelineSection from "./settings/PipelineSection.svelte";
import SearchSection from "./settings/SearchSection.svelte";
import TrustSection from "./settings/TrustSection.svelte";

interface Props {
	configFiles: ConfigFile[];
}

const { configFiles }: Props = $props();

// Track configFiles so the effect re-runs when the prop changes,
// but untrack the init call — it mutates $state which would
// otherwise trigger an infinite reactive loop.
$effect(() => {
	const files = configFiles;
	untrack(() => st.init(files));
});

async function saveSettings() {
	await st.save();
}

function formatSavedAt(raw: string | null): string {
	if (!raw) return "";
	try {
		return `Last saved ${new Date(raw).toLocaleTimeString()}`;
	} catch {
		return "";
	}
}

$effect(() => {
	setSettingsDirty(st.isDirty);
	return () => {
		setSettingsDirty(false);
	};
});
</script>

<div class="settings-tab">
	{#if !st.hasFiles}
		<div class="empty-state">No YAML config files found</div>
	{:else}
		<div class="form-body">
			<AgentSection />
			<EmbeddingsSection />
			<SearchSection />
			<MemorySection />
			<PathsSection />
			<PipelineSection />
			<TrustSection />
			<AuthSection />
		</div>

		<div class="save-bar">
			<div class="save-meta">
				<span class="save-state" class:dirty={st.isDirty}>
					{st.isDirty ? "Unsaved changes" : "All changes saved"}
				</span>
				{#if st.lastSavedAt}
					<span>{formatSavedAt(st.lastSavedAt)}</span>
				{/if}
				{#if st.lastSaveFeedback}
					<span>{st.lastSaveFeedback}</span>
				{/if}
			</div>
			<button class="save-btn" onclick={saveSettings} disabled={st.saving || !st.isDirty}>
				{st.saving ? "Saving…" : "Save"}
			</button>
		</div>
	{/if}
</div>

<style>
	.settings-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
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

	.form-body {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 56px;
	}

	/* Save bar */
	.save-bar {
		position: sticky;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: var(--space-md);
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

	.save-btn {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-bg);
		background: var(--sig-text-bright);
		border: none;
		border-radius: 0;
		padding: 6px 20px;
		cursor: pointer;
		transition: opacity var(--dur) var(--ease);
	}

	.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.save-btn:not(:disabled):hover { opacity: 0.85; }
</style>
