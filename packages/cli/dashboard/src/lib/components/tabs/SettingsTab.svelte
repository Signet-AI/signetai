<script lang="ts">
	import type { ConfigFile } from "$lib/api";
	import { st } from "$lib/stores/settings.svelte";
	import { setSettingsDirty } from "$lib/stores/unsaved-changes.svelte";
	import { untrack } from "svelte";
	import * as Popover from "$lib/components/ui/popover/index.js";
	import AgentSection from "./settings/AgentSection.svelte";
	import AuthSection from "./settings/AuthSection.svelte";
	import EmbeddingsSection from "./settings/EmbeddingsSection.svelte";
	import HarnessesSection from "./settings/HarnessesSection.svelte";
	import MemorySection from "./settings/MemorySection.svelte";
	import PathsSection from "./settings/PathsSection.svelte";
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
			paths: [["agent", "name"], ["agent", "description"]],
		},
		{
			id: "harnesses",
			title: "Harnesses",
			source: "agent",
			paths: [["harnesses"]],
		},
		{
			id: "embeddings",
			title: "Embeddings",
			source: "config",
			paths: [["embedding"], ["memory", "embeddings"], ["embeddings"]],
		},
		{
			id: "search",
			title: "Search",
			source: "config",
			paths: [["search"]],
		},
		{
			id: "memory",
			title: "Memory",
			source: "config",
			paths: [["memory", "session_budget"], ["memory", "current_md_budget"], ["memory", "decay_rate"]],
		},
		{
			id: "paths",
			title: "Paths",
			source: "agent",
			paths: [["paths"]],
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
	];

	let activeSection = $state("agent");
	let jumpMenuOpen = $state(false);
	let jumpFilter = $state("");
	let discardDialogOpen = $state(false);
	let jumpInputRef = $state<HTMLInputElement | null>(null);

	$effect(() => {
		const files = configFiles;
		untrack(() => st.init(files));
	});

	async function saveSettings() {
		await st.save();
	}

	let sections = $derived(
		sectionDefs.map((def) => ({
			id: def.id,
			title: def.title,
			dirty: st.isAnyPathDirty(def.source, def.paths),
		}))
	);

	let filteredSections = $derived(
		jumpFilter
			? sections.filter((s) => s.title.toLowerCase().includes(jumpFilter.toLowerCase()))
			: sections
	);

	let dirtySections = $derived(sections.filter((s) => s.dirty));
	let dirtyCount = $derived(dirtySections.length);
	let currentSection = $derived(sections.find((s) => s.id === activeSection));
	let currentSectionIndex = $derived(sections.findIndex((s) => s.id === activeSection) + 1);

	function handleGlobalKey(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const isInputFocused = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

		if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			if (st.isDirty && !st.saving) saveSettings();
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
				if (filteredSections[idx]) {
					switchSection(filteredSections[idx].id);
				}
			}
		}

		// Don't interfere with input fields
		if (isInputFocused) return;

		// Only handle section navigation when not in jump menu
		if (!jumpMenuOpen) {
			// Arrow Up from content returns focus to parent tab bar (handled by parent)
			// Arrow Left/Right cycle through sections within Settings tab
			if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				if (e.key === "ArrowLeft") {
					const currentIdx = currentSectionIndex - 1;
					if (currentIdx === 0) {
						// At first section - navigate back to engine tab bar
						e.preventDefault();
						window.dispatchEvent(new CustomEvent("engine-focus-tabs"));
						return;
					}
					e.preventDefault();
					const prevIdx = currentIdx - 1;
					switchSection(sections[prevIdx].id);
				} else {
					e.preventDefault();
					const nextIdx = currentSectionIndex >= sections.length ? 0 : currentSectionIndex;
					switchSection(sections[nextIdx].id);
				}
			}
		}
	}

	function switchSection(sectionId: string): void {
		jumpMenuOpen = false;
		jumpFilter = "";
		activeSection = sectionId;
	}

	function handleDiscard(): void {
		discardDialogOpen = true;
	}

	function confirmDiscard(): void {
		st.reset();
		discardDialogOpen = false;
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

<svelte:window onkeydown={handleGlobalKey} />

<div class="settings-tab">
	{#if !st.hasFiles}
		<div class="empty-state">No YAML config files found</div>
	{:else}
		<!-- Section header with navigation -->
		<header class="section-header">
			<div class="header-left">
				<button
					type="button"
					class="nav-btn"
					onclick={() => {
						const prevIdx = currentSectionIndex <= 1 ? sections.length - 1 : currentSectionIndex - 2;
						switchSection(sections[prevIdx].id);
					}}
					title="Previous section (←)"
				>
					←
				</button>

				<Popover.Root bind:open={jumpMenuOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button {...props} type="button" class="section-selector">
								<span class="section-title">{currentSection?.title || "Select section"}</span>
								{#if currentSection?.dirty}
									<span class="section-dirty" title="Unsaved changes">•</span>
								{/if}
								<span class="section-position">{currentSectionIndex}/{sections.length}</span>
								<span class="dropdown-arrow">▾</span>
							</button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="start" side="bottom" class="jump-menu">
						<div class="jump-filter">
							<input
								bind:this={jumpInputRef}
								type="text"
								placeholder="Filter sections..."
								bind:value={jumpFilter}
							/>
						</div>
						<div class="jump-list">
							{#each filteredSections as section, i (section.id)}
								<button
									type="button"
									class="jump-item"
									class:active={section.id === activeSection}
									class:dirty={section.dirty}
									onclick={() => switchSection(section.id)}
								>
									<span class="jump-num">{i + 1}</span>
									<span class="jump-title">{section.title}</span>
									{#if section.dirty}
										<span class="jump-dirty" title="Unsaved changes">•</span>
									{/if}
								</button>
							{/each}
							{#if filteredSections.length === 0}
								<div class="jump-empty">No sections found</div>
							{/if}
						</div>
						<div class="jump-footer">
							<span>1-9 jump</span>
							<span>←/→ nav</span>
							<span>Esc close</span>
						</div>
					</Popover.Content>
				</Popover.Root>

				<button
					type="button"
					class="nav-btn"
					onclick={() => {
						const nextIdx = currentSectionIndex >= sections.length ? 0 : currentSectionIndex;
						switchSection(sections[nextIdx].id);
					}}
					title="Next section (→)"
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

		<!-- Active section content -->
		<div class="section-content">
			{#if activeSection === "agent"}
				<AgentSection />
			{:else if activeSection === "harnesses"}
				<HarnessesSection />
			{:else if activeSection === "embeddings"}
				<EmbeddingsSection />
			{:else if activeSection === "search"}
				<SearchSection />
			{:else if activeSection === "memory"}
				<MemorySection />
			{:else if activeSection === "paths"}
				<PathsSection />
			{:else if activeSection === "pipeline"}
				<PipelineSection />
			{:else if activeSection === "trust"}
				<TrustSection />
			{:else if activeSection === "auth"}
				<AuthSection />
			{/if}
		</div>

		<!-- Save bar -->
		<footer class="save-bar">
			<div class="save-meta">
				<span class="save-state" class:dirty={st.isDirty}>
					{st.isDirty ? "Unsaved changes" : "All saved"}
				</span>
				{#if st.lastSavedAt}
					<span>{formatSavedAt(st.lastSavedAt)}</span>
				{/if}
			</div>
			{#if st.isDirty}
				<button type="button" class="discard-btn" onclick={handleDiscard} disabled={st.saving}>
					Discard
				</button>
			{/if}
			<button
				type="button"
				class="save-btn"
				onclick={saveSettings}
				disabled={st.saving || !st.isDirty}
				title="Save (Ctrl+S)"
			>
				{st.saving ? "Saving…" : "Save"}
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
						This will revert all unsaved changes in {dirtyCount} section{dirtyCount !== 1 ? "s" : ""}.
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

	.section-header {
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

	.section-selector {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 160px;
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

	.section-selector:hover {
		border-color: var(--sig-accent);
	}

	.section-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.section-dirty {
		color: var(--sig-accent);
		font-size: 16px;
		flex-shrink: 0;
	}

	.section-position {
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
		width: 240px;
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

	.jump-item.dirty .jump-title {
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

	.jump-title {
		flex: 1;
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

	.section-content {
		flex: 1;
		min-height: 0;
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
		.header-right {
			display: none;
		}

		.section-selector {
			padding: 6px 10px;
		}
	}
</style>
