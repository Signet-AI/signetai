<script lang="ts">
import { marked } from "marked";
import CodeEditor from "$lib/components/CodeEditor.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import Pencil from "@lucide/svelte/icons/pencil";
import Eye from "@lucide/svelte/icons/eye";

interface Props {
	content: string;
	filename: string;
	charBudget?: number;
	onchange?: (value: string) => void;
	onsave?: () => void;
}

let { content, filename, charBudget, onchange, onsave }: Props = $props();

function addBoxedHeadingClass(attrs: string): string {
	const classMatch = attrs.match(/\sclass=(['"])(.*?)\1/i);
	if (!classMatch) {
		return `${attrs} class="md-boxed-heading"`;
	}

	const quote = classMatch[1];
	const classes = classMatch[2]
		.split(/\s+/)
		.filter(Boolean);
	if (!classes.includes("md-boxed-heading")) {
		classes.push("md-boxed-heading");
	}

	return attrs.replace(
		/\sclass=(['"])(.*?)\1/i,
		` class=${quote}${classes.join(" ")}${quote}`,
	);
}

function addSectionHeadingBoxes(markdownHtml: string): string {
	return markdownHtml.replace(
		/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi,
		(full, level, attrs = "", inner = "") => {
			const attrsWithClass = addBoxedHeadingClass(attrs);
			return `<h${level}${attrsWithClass}>${inner}</h${level}>`;
		},
	);
}

let charCount = $derived(content?.length ?? 0);
let budgetPct = $derived(charBudget ? Math.round((charCount / charBudget) * 100) : 0);
let editing = $state(false);

let rendered = $derived.by(() => {
	if (!content) return "";
	const html = marked.parse(content, { async: false }) as string;
	return addSectionHeadingBoxes(html);
});
</script>

<div class="md-viewer">
	<div class="md-viewer-toolbar">
		<span class="md-viewer-filename">
			<span class="md-viewer-path">~/.agents/</span>{filename}
		</span>
		{#if charBudget}
			<span class="md-viewer-budget" class:over-budget={charCount > charBudget} class:near-budget={budgetPct >= 80 && charCount <= charBudget}>
				{charCount.toLocaleString()} / {charBudget.toLocaleString()} chars
				<span class="md-viewer-budget-pct">({budgetPct}%)</span>
			</span>
		{:else}
			<span class="md-viewer-budget">
				{charCount.toLocaleString()} chars
			</span>
		{/if}
		<div class="md-viewer-actions">
			{#if editing && onsave}
				<Button
					variant="outline"
					size="sm"
					class="h-auto rounded-none gap-1 font-[family-name:var(--font-mono)] text-[10px]
						font-medium uppercase tracking-[0.1em] px-2 py-[3px]
						border-[var(--sig-accent)] text-[var(--sig-text-bright)]
						hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]
						hover:border-[var(--sig-text-bright)]"
					onclick={onsave}
				>
					SAVE
				</Button>
			{/if}
			<Button
				variant="outline"
				size="sm"
				class="h-auto rounded-none gap-1 font-[family-name:var(--font-mono)] text-[10px]
					font-medium uppercase tracking-[0.1em] px-2 py-[3px]
					text-[var(--sig-text)] border-[var(--sig-border-strong)]
					hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-text-muted)]"
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
			</Button>
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

	.md-viewer-budget {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		letter-spacing: 0.02em;
	}

	.md-viewer-budget-pct {
		opacity: 0.6;
	}

	.md-viewer-budget.near-budget {
		color: var(--sig-warning, #d4a017);
	}

	.md-viewer-budget.over-budget {
		color: var(--sig-error, #e05252);
		font-weight: 600;
	}

	.md-viewer-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.md-viewer-prose {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-md) var(--space-lg);
	}

	:global(.md-viewer-prose .md-boxed-heading) {
		display: inline-block;
		padding: 0.35em 0.7em;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-surface-raised);
	}
</style>
