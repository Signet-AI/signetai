<script lang="ts">
import { marked } from "marked";
import CodeEditor from "$lib/components/CodeEditor.svelte";
import Pencil from "@lucide/svelte/icons/pencil";
import Eye from "@lucide/svelte/icons/eye";

interface Props {
	content: string;
	filename: string;
	onchange?: (value: string) => void;
	onsave?: () => void;
}

let { content, filename, onchange, onsave }: Props = $props();
let editing = $state(false);

let rendered = $derived.by(() => {
	if (!content) return "";
	return marked.parse(content, { async: false }) as string;
});
</script>

<div class="md-viewer">
	<div class="md-viewer-toolbar">
		<span class="md-viewer-filename">
			<span class="md-viewer-path">~/.agents/</span>{filename}
		</span>
		<div class="md-viewer-actions">
			{#if editing && onsave}
				<button class="md-viewer-btn save" onclick={onsave}>
					SAVE
				</button>
			{/if}
			<button
				class="md-viewer-btn"
				onclick={() => (editing = !editing)}
				title={editing ? "Preview" : "Edit"}
			>
				{#if editing}
					<Eye size={13} />
					<span>Preview</span>
				{:else}
					<Pencil size={13} />
					<span>Edit</span>
				{/if}
			</button>
		</div>
	</div>

	{#if editing}
		<CodeEditor
			value={content}
			language="markdown"
			onchange={onchange}
			{onsave}
		/>
	{:else}
		<div class="md-viewer-prose prose">
			{@html rendered}
		</div>
	{/if}
</div>

<style>
	.md-viewer {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.md-viewer-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 36px;
		padding: 0 var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.md-viewer-filename {
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
	}

	.md-viewer-path {
		color: var(--sig-text-muted);
	}

	.md-viewer-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.md-viewer-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text);
		background: none;
		border: 1px solid var(--sig-border-strong);
		padding: 3px 8px;
		cursor: pointer;
	}

	.md-viewer-btn:hover {
		color: var(--sig-text-bright);
		border-color: var(--sig-text-muted);
	}

	.md-viewer-btn.save {
		color: var(--sig-text-bright);
		border-color: var(--sig-accent);
	}

	.md-viewer-btn.save:hover {
		background: var(--sig-text-bright);
		color: var(--sig-bg);
		border-color: var(--sig-text-bright);
	}

	.md-viewer-prose {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-md) var(--space-lg);
	}
</style>
