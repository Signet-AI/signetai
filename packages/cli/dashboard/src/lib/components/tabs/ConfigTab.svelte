<script lang="ts">
import { saveConfigFile, type ConfigFile } from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";
import MarkdownViewer from "$lib/components/config/MarkdownViewer.svelte";

interface Props {
	configFiles: ConfigFile[];
	selectedFile: string;
	onselectfile: (name: string) => void;
}

let { configFiles, selectedFile, onselectfile }: Props = $props();

let mdFiles = $derived(
	configFiles?.filter((f) => f.name.endsWith(".md")) ?? [],
);

// Auto-select first md file if current selection isn't an md file
$effect(() => {
	if (mdFiles.length && !mdFiles.some((f) => f.name === selectedFile)) {
		onselectfile(mdFiles[0].name);
	}
});

let activeFile = $derived(mdFiles.find((f) => f.name === selectedFile));

let editorContent = $state("");
let saving = $state(false);

$effect(() => {
	editorContent = activeFile?.content ?? "";
});

async function saveFile() {
	saving = true;
	try {
		const success = await saveConfigFile(selectedFile, editorContent);
		if (success) {
			toast(`${selectedFile} saved`, "success");
		} else {
			toast("Failed to save file", "error");
		}
	} finally {
		saving = false;
	}
}
</script>

<div class="config-tab">
	<nav class="config-file-list">
		{#each mdFiles as file (file.name)}
			<button
				class="config-file-item"
				class:active={file.name === selectedFile}
				onclick={() => onselectfile(file.name)}
			>
				{file.name}
			</button>
		{/each}
	</nav>

	{#if activeFile}
		<MarkdownViewer
			content={editorContent}
			filename={selectedFile}
			onchange={(v) => { editorContent = v; }}
			onsave={saveFile}
		/>
	{:else}
		<div class="config-empty">
			<span>No markdown files found</span>
		</div>
	{/if}
</div>

<style>
	.config-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.config-file-list {
		display: flex;
		gap: 0;
		padding: 0 var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
		overflow-x: auto;
	}

	.config-file-item {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
		background: none;
		border: none;
		border-bottom: 1px solid transparent;
		padding: 8px 12px;
		cursor: pointer;
		white-space: nowrap;
		transition:
			color var(--dur) var(--ease),
			border-color var(--dur) var(--ease);
	}

	.config-file-item:hover {
		color: var(--sig-text);
	}

	.config-file-item.active {
		color: var(--sig-text-bright);
		border-bottom-color: var(--sig-text-bright);
	}

	.config-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--sig-text-muted);
	}
</style>
