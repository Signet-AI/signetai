<script lang="ts">
	import { saveConfigFileResult, type ConfigFile } from "$lib/api";
	import { toast } from "$lib/stores/toast.svelte";
	import { confirmDiscardChanges, setConfigDirty } from "$lib/stores/unsaved-changes.svelte";
	import MarkdownViewer from "$lib/components/config/MarkdownViewer.svelte";
	import * as Popover from "$lib/components/ui/popover/index.js";
	import PanelLeftClose from "@lucide/svelte/icons/panel-left-close";
	import PanelLeft from "@lucide/svelte/icons/panel-left";

	interface Props {
		configFiles: ConfigFile[];
		onDirtyChange?: (dirty: boolean) => void;
	}

	let { configFiles, onDirtyChange }: Props = $props();

	const CHAR_BUDGETS: Record<string, number> = {
		"AGENTS.md": 12000,
		"MEMORY.md": 10000,
		"USER.md": 6000,
		"SOUL.md": 4000,
		"IDENTITY.md": 2000,
	};

	let mdFiles = $derived(
		configFiles?.filter((f) => f.name.endsWith(".md")) ?? [],
	);

	let selectedFile = $state("");
	let prevSelectedFile = $state("");
	let editorContent = $state("");
	let saving = $state(false);
	let savedByFile = $state<Record<string, string>>({});
	let collapsed = $state(false);
	let jumpMenuOpen = $state(false);
	let jumpFilter = $state("");
	let jumpInputRef = $state<HTMLInputElement | null>(null);

	let activeFile = $derived(mdFiles.find((f) => f.name === selectedFile));

	let isDirty = $derived(
		(savedByFile[selectedFile] ?? activeFile?.content ?? "") !== editorContent,
	);

	let budgetPct = $derived.by(() => {
		const budget = CHAR_BUDGETS[selectedFile];
		if (!budget || !activeFile) return null;
		return Math.round((editorContent.length / budget) * 100);
	});

	let filteredFiles = $derived(
		jumpFilter
			? mdFiles.filter((f) =>
					f.name.toLowerCase().includes(jumpFilter.toLowerCase()),
				)
			: mdFiles,
	);

	// Auto-select first md file
	$effect(() => {
		if (mdFiles.length && !mdFiles.some((f) => f.name === selectedFile)) {
			selectedFile = mdFiles[0].name;
		}
	});

	// Initialize savedByFile for new files
	$effect(() => {
		for (const file of mdFiles) {
			if (savedByFile[file.name] === undefined) {
				savedByFile = { ...savedByFile, [file.name]: file.content };
			}
		}
	});

	// Load content when switching files
	$effect(() => {
		if (selectedFile !== prevSelectedFile) {
			prevSelectedFile = selectedFile;
			editorContent = activeFile?.content ?? "";
		}
	});

	// Notify parent of dirty state changes
	$effect(() => {
		onDirtyChange?.(isDirty);
		setConfigDirty(isDirty);
		return () => {
			setConfigDirty(false);
		};
	});

	// Ctrl+J jump menu within panel
	function handlePanelKey(e: KeyboardEvent): void {
		if (collapsed) return;
		if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			jumpMenuOpen = true;
			setTimeout(() => jumpInputRef?.focus(), 0);
			return;
		}
		if (jumpMenuOpen && e.key === "Escape") {
			e.preventDefault();
			jumpMenuOpen = false;
			jumpFilter = "";
		}
	}

	function selectFileWithGuard(name: string): void {
		if (name === selectedFile) return;
		if (
			isDirty &&
			!confirmDiscardChanges(`switch files from ${selectedFile} to ${name}`)
		) {
			return;
		}
		jumpMenuOpen = false;
		jumpFilter = "";
		selectedFile = name;
	}

	function getBudgetColor(): string {
		if (budgetPct === null) return "var(--sig-text-muted)";
		if (budgetPct > 100) return "var(--sig-danger)";
		if (budgetPct >= 80) return "var(--sig-warning, #d4a017)";
		return "var(--sig-success)";
	}

	function formatSavedAt(raw: string | null): string {
		if (!raw) return "";
		try {
			return `Last saved ${new Date(raw).toLocaleTimeString()}`;
		} catch {
			return "";
		}
	}

	let lastSavedAt = $state<string | null>(null);
	let saveFeedback = $state("");

	// Exposed methods for parent via bind:this
	export async function save(): Promise<void> {
		if (!isDirty) return;
		const contentToSave = editorContent;
		saving = true;
		try {
			const result = await saveConfigFileResult(selectedFile, contentToSave);
			if (result.ok) {
				savedByFile = { ...savedByFile, [selectedFile]: contentToSave };
				lastSavedAt = new Date().toISOString();
				saveFeedback = `Saved ${selectedFile}`;
				toast(saveFeedback, "success");
			} else {
				saveFeedback = `Failed to save ${selectedFile}`;
				toast(
					`${saveFeedback}: ${result.error ?? "unknown error"}`,
					"error",
				);
			}
		} finally {
			saving = false;
		}
	}

	export function discard(): void {
		if (activeFile) {
			editorContent = activeFile.content;
			savedByFile = { ...savedByFile, [selectedFile]: activeFile.content };
		}
	}
</script>

<svelte:window onkeydown={handlePanelKey} />

{#if collapsed}
	<div class="panel-collapsed">
		<button
			type="button"
			class="collapse-toggle"
			onclick={() => (collapsed = false)}
			title="Open identity panel"
		>
			<PanelLeft size={14} />
		</button>
	</div>
{:else}
	<div class="identity-panel">
		<header class="panel-header">
			<div class="header-left">
				<Popover.Root bind:open={jumpMenuOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button {...props} type="button" class="file-selector">
								<span class="file-name">{selectedFile || "Select file"}</span>
								{#if isDirty}
									<span class="file-dirty" title="Unsaved changes"
										>&bull;</span
									>
								{/if}
								<span class="dropdown-arrow">&#9662;</span>
							</button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="start" side="bottom" class="jump-menu">
						<div class="jump-filter">
							<input
								bind:this={jumpInputRef}
								type="text"
								placeholder="Filter files..."
								bind:value={jumpFilter}
							/>
						</div>
						<div class="jump-list">
							{#each filteredFiles as file, i (file.name)}
								<button
									type="button"
									class="jump-item"
									class:active={file.name === selectedFile}
									onclick={() => selectFileWithGuard(file.name)}
								>
									<span class="jump-num">{i + 1}</span>
									<span class="jump-name">{file.name}</span>
								</button>
							{/each}
							{#if filteredFiles.length === 0}
								<div class="jump-empty">No files found</div>
							{/if}
						</div>
					</Popover.Content>
				</Popover.Root>
			</div>

			<button
				type="button"
				class="collapse-toggle"
				onclick={() => (collapsed = true)}
				title="Collapse panel"
			>
				<PanelLeftClose size={14} />
			</button>
		</header>

		<!-- Budget bar -->
		{#if budgetPct !== null}
			<div class="budget-bar-container">
				<div class="budget-bar-track">
					<div
						class="budget-bar-fill"
						style="width: {Math.min(budgetPct, 100)}%; background: {getBudgetColor()}"
					></div>
				</div>
				<span class="budget-label" style="color: {getBudgetColor()}">
					{editorContent.length.toLocaleString()} / {CHAR_BUDGETS[selectedFile]?.toLocaleString()} ({budgetPct}%)
				</span>
			</div>
		{/if}

		<!-- Editor -->
		{#if activeFile}
			<div class="panel-editor">
				<MarkdownViewer
					content={editorContent}
					filename={selectedFile}
					charBudget={CHAR_BUDGETS[selectedFile]}
					onchange={(v) => {
						editorContent = v;
					}}
					onsave={save}
					ondiscard={discard}
					dirty={isDirty}
					{saving}
					saveDisabled={!isDirty || saving}
					lastSavedText={formatSavedAt(lastSavedAt)}
					{saveFeedback}
				/>
			</div>
		{:else if mdFiles.length === 0}
			<div class="panel-empty">No identity files found</div>
		{/if}
	</div>
{/if}

<style>
	.identity-panel {
		display: flex;
		flex-direction: column;
		min-width: 280px;
		width: 350px;
		max-width: 50vw;
		border-left: 1px solid var(--sig-border);
		background: var(--sig-bg);
		resize: horizontal;
		overflow: auto;
	}

	.panel-collapsed {
		display: flex;
		align-items: flex-start;
		padding-top: var(--space-sm);
		border-left: 1px solid var(--sig-border);
		background: var(--sig-bg);
		width: 36px;
		flex-shrink: 0;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-sm);
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface);
		flex-shrink: 0;
	}

	.header-left {
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
	}

	.collapse-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		color: var(--sig-text-muted);
		background: none;
		border: 1px solid var(--sig-border);
		cursor: pointer;
		flex-shrink: 0;
		transition: color 0.15s ease, border-color 0.15s ease;
	}

	.collapse-toggle:hover {
		color: var(--sig-text-bright);
		border-color: var(--sig-border-strong);
	}

	.file-selector {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		cursor: pointer;
		transition: border-color 0.15s ease;
		min-width: 0;
	}

	.file-selector:hover {
		border-color: var(--sig-accent);
	}

	.file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-dirty {
		color: var(--sig-accent);
		font-size: 16px;
		flex-shrink: 0;
	}

	.dropdown-arrow {
		font-size: 10px;
		color: var(--sig-text-muted);
		flex-shrink: 0;
	}

	.budget-bar-container {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 4px var(--space-sm);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.budget-bar-track {
		flex: 1;
		height: 3px;
		background: var(--sig-surface-raised);
		border-radius: 1px;
		overflow: hidden;
	}

	.budget-bar-fill {
		height: 100%;
		border-radius: 1px;
		transition: width 0.2s ease, background 0.2s ease;
	}

	.budget-label {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.02em;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.panel-editor {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.panel-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--sig-text-muted);
	}

	/* Jump menu styles (shared with ConfigTab) */
	:global(.jump-menu) {
		width: 220px;
		padding: 0;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	.jump-filter {
		padding: 6px;
		border-bottom: 1px solid var(--sig-border);
	}

	.jump-filter input {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		padding: 4px 6px;
		outline: none;
	}

	.jump-filter input:focus {
		border-color: var(--sig-accent);
	}

	.jump-list {
		max-height: 240px;
		overflow-y: auto;
	}

	.jump-item {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s ease;
	}

	.jump-item:hover {
		background: var(--sig-surface);
	}

	.jump-item.active {
		background: var(--sig-surface);
		color: var(--sig-text-bright);
	}

	.jump-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		font-size: 9px;
		color: var(--sig-text-muted);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
	}

	.jump-item.active .jump-num {
		background: var(--sig-accent);
		color: var(--sig-bg);
		border-color: var(--sig-accent);
	}

	.jump-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.jump-empty {
		padding: 12px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		text-align: center;
	}
</style>
