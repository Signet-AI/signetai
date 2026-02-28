<script lang="ts">
import type { ConfigFile } from "$lib/api";
import { st } from "$lib/stores/settings.svelte";
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

$effect(() => {
	st.init(configFiles);
});

async function saveSettings() {
	await st.save();
}
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
			<button class="save-btn" onclick={saveSettings} disabled={st.saving}>
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
		justify-content: flex-end;
		padding: var(--space-sm) var(--space-md);
		background: var(--sig-surface);
		border-top: 1px solid var(--sig-border);
		flex-shrink: 0;
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
