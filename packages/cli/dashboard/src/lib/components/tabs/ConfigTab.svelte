<script lang="ts">
import { saveConfigFile, type ConfigFile } from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";
import MarkdownViewer from "$lib/components/config/MarkdownViewer.svelte";
import * as Tabs from "$lib/components/ui/tabs/index.js";


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

// Char budgets from session start hook (packages/daemon/src/hooks.ts)
const CHAR_BUDGETS: Record<string, number> = {
	"AGENTS.md": 12000,
	"MEMORY.md": 10000,
	"USER.md": 6000,
	"SOUL.md": 4000,
	"IDENTITY.md": 2000,
};

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
	<Tabs.Root value={selectedFile} onValueChange={(v) => onselectfile(v)}>
		<Tabs.List class="bg-transparent h-auto gap-0 rounded-none border-b border-[var(--sig-border)] px-[var(--space-md)] w-full justify-start">
			{#each mdFiles as file (file.name)}
				<Tabs.Trigger
					value={file.name}
					class="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.04em]
						text-[var(--sig-text-muted)] rounded-none bg-transparent
						border-b border-b-transparent px-3 py-2
						data-[state=active]:text-[var(--sig-text-bright)]
						data-[state=active]:border-b-[var(--sig-text-bright)]
						data-[state=active]:shadow-none
						hover:text-[var(--sig-text)]"
				>
					{file.name}
					{#if CHAR_BUDGETS[file.name]}
						<span class="ml-1 text-[8px] opacity-40">{Math.round((file.content.length / CHAR_BUDGETS[file.name]) * 100)}%</span>
					{/if}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>

	{#if activeFile}
		<MarkdownViewer
			content={editorContent}
			filename={selectedFile}
			charBudget={CHAR_BUDGETS[selectedFile]}
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
