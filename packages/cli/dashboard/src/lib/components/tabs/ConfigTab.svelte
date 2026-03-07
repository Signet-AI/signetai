<script lang="ts">
	import { saveConfigFileResult, type ConfigFile } from "$lib/api";
	import { toast } from "$lib/stores/toast.svelte";
	import { confirmDiscardChanges, setConfigDirty } from "$lib/stores/unsaved-changes.svelte";
	import { returnToSidebar } from "$lib/stores/focus.svelte";
	import MarkdownViewer from "$lib/components/config/MarkdownViewer.svelte";
	import * as Popover from "$lib/components/ui/popover/index.js";

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
	let prevSelectedFile = $state("");
	let saving = $state(false);
	let lastSavedAt = $state<string | null>(null);
	let saveFeedback = $state("");
	let savedByFile = $state<Record<string, string>>({});

	let isDirty = $derived((savedByFile[selectedFile] ?? activeFile?.content ?? "") !== editorContent);

	// Track dirty state per file
	let fileDirtyState = $derived.by(() => {
		const result: Record<string, boolean> = {};
		for (const file of mdFiles) {
			if (file.name === selectedFile) {
				result[file.name] = (savedByFile[file.name] ?? file.content) !== editorContent;
			} else {
				result[file.name] = false;
			}
		}
		return result;
	});

	let dirtyCount = $derived(Object.values(fileDirtyState).filter(Boolean).length);

	let currentFileIndex = $derived(mdFiles.findIndex((f) => f.name === selectedFile) + 1);

	let jumpMenuOpen = $state(false);
	let jumpFilter = $state("");
	let jumpInputRef = $state<HTMLInputElement | null>(null);

	// Initialize savedByFile for new files
	$effect(() => {
		for (const file of mdFiles) {
			if (savedByFile[file.name] === undefined) {
				savedByFile = { ...savedByFile, [file.name]: file.content };
			}
		}
	});

	// Load content only when switching to a different file
	$effect(() => {
		if (selectedFile !== prevSelectedFile) {
			prevSelectedFile = selectedFile;
			editorContent = activeFile?.content ?? "";
		}
	});

	// Track dirty state globally
	$effect(() => {
		setConfigDirty(isDirty);
		return () => {
			setConfigDirty(false);
		};
	});

	function selectFileWithGuard(name: string): void {
		if (name === selectedFile) return;
		if (isDirty && !confirmDiscardChanges(`switch files from ${selectedFile} to ${name}`)) {
			return;
		}
		jumpMenuOpen = false;
		jumpFilter = "";
		onselectfile(name);
	}

	function handleGlobalKey(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const isInputFocused = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

		if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (isDirty && !saving) saveFile();
			return;
		}

		if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			jumpMenuOpen = true;
			setTimeout(() => jumpInputRef?.focus(), 0);
			return;
		}

		if (jumpMenuOpen) {
			if (e.key === "Escape") {
				e.preventDefault();
				jumpMenuOpen = false;
				jumpFilter = "";
			}
			if (!isInputFocused && /^[1-9]$/.test(e.key)) {
				e.preventDefault();
				const idx = parseInt(e.key, 10) - 1;
				if (idx < filteredFiles.length && filteredFiles[idx]) {
					selectFileWithGuard(filteredFiles[idx].name);
				}
			}
		}

		if (!isInputFocused && !jumpMenuOpen) {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				const currentIdx = mdFiles.findIndex((f) => f.name === selectedFile);
				if (currentIdx === 0) {
					// At first file, return to sidebar
					returnToSidebar();
				} else {
					// Navigate to previous file
					const prevIdx = currentIdx <= 0 ? mdFiles.length - 1 : currentIdx - 1;
					if (mdFiles[prevIdx]) selectFileWithGuard(mdFiles[prevIdx].name);
				}
			}
			if (e.key === "ArrowRight") {
				e.preventDefault();
				const currentIdx = mdFiles.findIndex((f) => f.name === selectedFile);
				const nextIdx = currentIdx >= mdFiles.length - 1 ? 0 : currentIdx + 1;
				if (mdFiles[nextIdx]) selectFileWithGuard(mdFiles[nextIdx].name);
			}
			if (e.key === "ArrowDown") {
				// Focus the CodeMirror editor
				e.preventDefault();
				const editorElement = document.querySelector('.cm-editor');
				if (editorElement instanceof HTMLElement) {
					editorElement.focus();
				}
			}
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

	function getBudgetPct(filename: string): number | null {
		const budget = CHAR_BUDGETS[filename];
		if (!budget) return null;
		const file = mdFiles.find((f) => f.name === filename);
		if (!file) return null;
		return Math.round((file.content.length / budget) * 100);
	}

	function discardChanges(): void {
		if (activeFile) {
			editorContent = activeFile.content;
			savedByFile = { ...savedByFile, [selectedFile]: activeFile.content };
		}
	}

	async function saveFile() {
		if (!isDirty) {
			saveFeedback = "No changes to save";
			return;
		}

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
				toast(`${saveFeedback}: ${result.error ?? "unknown error"}`, "error");
			}
		} finally {
			saving = false;
		}
	}

	let filteredFiles = $derived(
		jumpFilter
			? mdFiles.filter((f) => f.name.toLowerCase().includes(jumpFilter.toLowerCase()))
			: mdFiles
	);
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="config-tab">
	{#if mdFiles.length === 0}
		<div class="config-empty">No markdown files found</div>
	{:else}
		<!-- File header with navigation -->
		<header class="file-header">
			<div class="header-left">
				<button
					type="button"
					class="nav-btn"
					onclick={() => {
						const currentIdx = mdFiles.findIndex((f) => f.name === selectedFile);
						const prevIdx = currentIdx <= 0 ? mdFiles.length - 1 : currentIdx - 1;
						if (mdFiles[prevIdx]) selectFileWithGuard(mdFiles[prevIdx].name);
					}}
					title="Previous file (←)"
				>
					←
				</button>

				<Popover.Root bind:open={jumpMenuOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button {...props} type="button" class="file-selector">
								<span class="file-name">{selectedFile}</span>
								{#if getBudgetPct(selectedFile) !== null}
									<span class="file-budget" class:over-budget={getBudgetPct(selectedFile)! > 100} class:near-budget={getBudgetPct(selectedFile)! >= 80 && getBudgetPct(selectedFile)! <= 100}>
										{getBudgetPct(selectedFile)}%
									</span>
								{/if}
								{#if isDirty}
									<span class="file-dirty" title="Unsaved changes">•</span>
								{/if}
								<span class="file-position">{currentFileIndex}/{mdFiles.length}</span>
								<span class="dropdown-arrow">▾</span>
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
									class:dirty={file.name === selectedFile && isDirty}
									onclick={() => selectFileWithGuard(file.name)}
								>
									<span class="jump-num">{i + 1}</span>
									<span class="jump-name">{file.name}</span>
									{#if getBudgetPct(file.name) !== null}
										<span class="jump-budget" class:over-budget={getBudgetPct(file.name)! > 100} class:near-budget={getBudgetPct(file.name)! >= 80 && getBudgetPct(file.name)! <= 100}>
											{getBudgetPct(file.name)}%
										</span>
									{/if}
									{#if file.name === selectedFile && isDirty}
										<span class="jump-dirty" title="Unsaved changes">•</span>
									{/if}
								</button>
							{/each}
							{#if filteredFiles.length === 0}
								<div class="jump-empty">No files found</div>
							{/if}
						</div>
						<div class="jump-footer">
							<span>1-{Math.min(9, mdFiles.length)} jump</span>
							<span>←/→ nav</span>
							<span>Esc close</span>
						</div>
					</Popover.Content>
				</Popover.Root>

				<button
					type="button"
					class="nav-btn"
					onclick={() => {
						const currentIdx = mdFiles.findIndex((f) => f.name === selectedFile);
						const nextIdx = currentIdx >= mdFiles.length - 1 ? 0 : currentIdx + 1;
						if (mdFiles[nextIdx]) selectFileWithGuard(mdFiles[nextIdx].name);
					}}
					title="Next file (→)"
				>
					→
				</button>
			</div>

			<div class="header-right">
				{#if dirtyCount > 0}
					<span class="dirty-badge">{dirtyCount} unsaved</span>
				{/if}
			</div>
		</header>

		<!-- File content -->
		{#if activeFile}
			<MarkdownViewer
				content={editorContent}
				filename={selectedFile}
				charBudget={CHAR_BUDGETS[selectedFile]}
				onchange={(v) => { editorContent = v; }}
				onsave={saveFile}
				ondiscard={discardChanges}
				dirty={isDirty}
				saving={saving}
				saveDisabled={!isDirty || saving}
				lastSavedText={formatSavedAt(lastSavedAt)}
				saveFeedback={saveFeedback}
			/>
		{/if}
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

	.file-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		background: var(--sig-surface);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.nav-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		font-family: var(--font-mono);
		font-size: 14px;
		color: var(--sig-text-muted);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.nav-btn:hover:not(:disabled) {
		color: var(--sig-text);
		border-color: var(--sig-border-strong);
	}

	.nav-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.file-selector {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 180px;
		padding: 6px 12px;
		font-family: var(--font-display);
		font-size: 13px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.file-selector:hover {
		border-color: var(--sig-accent);
	}

	.file-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-budget {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: normal;
		text-transform: none;
		color: var(--sig-text-muted);
		flex-shrink: 0;
	}

	.file-budget.near-budget {
		color: var(--sig-warning, #d4a017);
	}

	.file-budget.over-budget {
		color: var(--sig-error, #e05252);
		font-weight: 600;
	}

	.file-dirty {
		color: var(--sig-accent);
		font-size: 16px;
		flex-shrink: 0;
	}

	.file-position {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: normal;
		color: var(--sig-text-muted);
		text-transform: none;
		flex-shrink: 0;
	}

	.dropdown-arrow {
		font-size: 10px;
		color: var(--sig-text-muted);
		flex-shrink: 0;
	}

	.dirty-badge {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-warning, #d4a017);
		padding: 3px 8px;
		background: color-mix(in srgb, var(--sig-warning, #d4a017) 15%, transparent);
		border: 1px solid var(--sig-warning, #d4a017);
	}

	:global(.jump-menu) {
		width: 260px;
		padding: 0;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	.jump-filter {
		padding: 8px;
		border-bottom: 1px solid var(--sig-border);
	}

	.jump-filter input {
		width: 100%;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		padding: 6px 8px;
		outline: none;
	}

	.jump-filter input:focus {
		border-color: var(--sig-accent);
	}

	.jump-list {
		max-height: 280px;
		overflow-y: auto;
	}

	.jump-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
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

	.jump-item.dirty .jump-name {
		font-weight: 600;
	}

	.jump-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
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
	}

	.jump-budget {
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	.jump-budget.near-budget {
		color: var(--sig-warning, #d4a017);
	}

	.jump-budget.over-budget {
		color: var(--sig-error, #e05252);
	}

	.jump-dirty {
		color: var(--sig-accent);
		font-size: 14px;
	}

	.jump-empty {
		padding: 16px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		text-align: center;
	}

	.jump-footer {
		display: flex;
		justify-content: space-between;
		padding: 6px 10px;
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		border-top: 1px solid var(--sig-border);
	}

	@media (max-width: 640px) {
		.header-right {
			display: none;
		}

		.file-selector {
			padding: 6px 10px;
		}
	}
</style>
