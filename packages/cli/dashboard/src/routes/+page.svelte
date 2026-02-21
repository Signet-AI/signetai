<script lang="ts">
import { onMount } from "svelte";
import { browser } from "$app/environment";
import { getStatus, type DaemonStatus, type Memory } from "$lib/api";
import {
	mem,
	hasActiveFilters,
	clearAll,
	clearSearchTimer,
	queueMemorySearch,
	findSimilar,
	loadWhoOptions,
} from "$lib/stores/memory.svelte";
import BgField from "$lib/components/BgField.svelte";
import AppHeader from "$lib/components/AppHeader.svelte";
import LeftSidebar from "$lib/components/LeftSidebar.svelte";
import RightMemoryPanel from "$lib/components/RightMemoryPanel.svelte";
import ConfigTab from "$lib/components/tabs/ConfigTab.svelte";
import LogsTab from "$lib/components/tabs/LogsTab.svelte";
import SecretsTab from "$lib/components/tabs/SecretsTab.svelte";
import SkillsTab from "$lib/components/tabs/SkillsTab.svelte";
import MemoryTab from "$lib/components/tabs/MemoryTab.svelte";
import EmbeddingsTab from "$lib/components/tabs/EmbeddingsTab.svelte";

let { data } = $props();
let daemonStatus = $state<DaemonStatus | null>(null);

// --- Theme ---
let theme = $state<"dark" | "light">("dark");

if (browser) {
	const stored = document.documentElement.dataset.theme;
	theme = stored === "light" || stored === "dark" ? stored : "dark";
}

function toggleTheme() {
	theme = theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = theme;
	localStorage.setItem("signet-theme", theme);
}

// --- Tabs ---
let activeTab = $state<
	"config" | "memory" | "embeddings" | "logs" | "secrets" | "skills"
>("config");

// --- Config file selection ---
let selectedFile = $state("");

$effect(() => {
	if (!selectedFile && data.configFiles?.length) {
		selectedFile = data.configFiles[0].name;
	}
});

function selectFile(name: string) {
	selectedFile = name;
	activeTab = "config";
}

function ext(name: string): string {
	return name.split(".").pop() ?? "";
}

// --- Memory display (derived from store for tab info + status bar) ---
let memoryDocs = $derived((data.memories ?? []) as Memory[]);

let displayMemories = $derived(
	mem.similarSourceId
		? mem.similarResults
		: mem.searched || hasActiveFilters()
			? mem.results
			: memoryDocs,
);

// --- Filter reactivity ---
$effect(() => {
	const _ = mem.filterType,
		__ = mem.filterTags,
		___ = mem.filterWho,
		____ = mem.filterPinned,
		_____ = mem.filterImportanceMin,
		______ = mem.filterSince;
	if (hasActiveFilters() || mem.searched) {
		queueMemorySearch();
	}
});

// --- Embeddings bridge ---
function openGlobalSimilar(memory: Memory) {
	mem.query = memory.content;
	activeTab = "memory";
	queueMemorySearch();
}

// --- Cleanup ---
$effect(() => {
	return () => {
		clearSearchTimer();
	};
});

// --- Init ---
onMount(() => {
	getStatus().then((s) => {
		daemonStatus = s;
	});
	loadWhoOptions();
});
</script>

<svelte:head>
  <title>Signet</title>
</svelte:head>

<div class="app">
  <BgField
    version={daemonStatus?.version ?? '0.1.0'}
    memCount={data.memoryStats?.total ?? 0}
  />

  <AppHeader
    memCount={data.memoryStats?.total ?? 0}
    harnessCount={data.harnesses?.length ?? 0}
    {daemonStatus}
    {theme}
    onthemetoggle={toggleTheme}
  />

  <div class="main">
    <LeftSidebar
      identity={data.identity}
      harnesses={data.harnesses}
      configFiles={data.configFiles}
      {selectedFile}
      memCount={data.memoryStats?.total ?? 0}
      onselectfile={selectFile}
    />

    <!-- Center Panel -->
    <main class="center">
      <!-- Tabs -->
      <div class="tabs">
        <div class="tab-group">
          <button class="tab" class:tab-active={activeTab === 'config'} onclick={() => activeTab = 'config'}>
            Config
          </button>
          <button class="tab" class:tab-active={activeTab === 'memory'} onclick={() => activeTab = 'memory'}>
            Memory
          </button>
          <button class="tab" class:tab-active={activeTab === 'embeddings'} onclick={() => activeTab = 'embeddings'}>
            Embeddings
          </button>
          <button class="tab" class:tab-active={activeTab === 'logs'} onclick={() => activeTab = 'logs'}>
            Logs
          </button>
          <button class="tab" class:tab-active={activeTab === 'secrets'} onclick={() => activeTab = 'secrets'}>
            Secrets
          </button>
          <button class="tab" class:tab-active={activeTab === 'skills'} onclick={() => activeTab = 'skills'}>
            Skills
          </button>
        </div>

        <div class="tab-info">
          {#if activeTab === 'config'}
            <!-- save actions in editor-chrome -->
          {:else if activeTab === 'memory'}
            <span class="status-text">{displayMemories.length} documents</span>
            {#if mem.searching}
              <span class="status-text">searching embeddings...</span>
            {/if}
            {#if mem.searched || hasActiveFilters() || mem.similarSourceId}
              <button class="btn-text" onclick={clearAll}>Reset</button>
            {/if}
          {:else if activeTab === 'embeddings'}
            <span class="status-text">Embeddings</span>
          {:else if activeTab === 'logs'}
            <span class="status-text">Logs</span>
          {:else if activeTab === 'secrets'}
            <span class="status-text">Secrets</span>
          {:else if activeTab === 'skills'}
            <span class="status-text">Skills</span>
          {/if}
        </div>
      </div>

      <!-- Content -->
      <div class="content">
        {#if activeTab === 'config'}
          <ConfigTab
            configFiles={data.configFiles}
            {selectedFile}
            onselectfile={selectFile}
          />
        {:else if activeTab === 'memory'}
          <MemoryTab memories={memoryDocs} />
        {:else if activeTab === 'embeddings'}
          <EmbeddingsTab onopenglobalsimilar={openGlobalSimilar} />
        {:else if activeTab === 'logs'}
          <LogsTab />
        {:else if activeTab === 'secrets'}
          <SecretsTab />
        {:else if activeTab === 'skills'}
          <SkillsTab />
        {/if}
      </div>

      <!-- Status Bar -->
      <div class="statusbar">
        {#if activeTab === 'config'}
          <span>{ext(selectedFile).toUpperCase()}</span>
          <span class="statusbar-right">
            <kbd>Cmd+S</kbd> to save
          </span>
        {:else if activeTab === 'memory'}
          <span>{displayMemories.length} memory documents</span>
          <span class="statusbar-right">
            {#if mem.searching}
              semantic search in progress
            {:else if mem.similarSourceId}
              similarity mode
            {:else}
              hybrid embedding index
            {/if}
          </span>
        {:else if activeTab === 'embeddings'}
          <span>Embedding graph</span>
          <span class="statusbar-right">UMAP</span>
        {:else if activeTab === 'logs'}
          <span>Log viewer</span>
          <span class="statusbar-right">daemon logs</span>
        {:else if activeTab === 'secrets'}
          <span>Secrets</span>
          <span class="statusbar-right">Encrypted with libsodium</span>
        {:else if activeTab === 'skills'}
          <span>Skills</span>
          <span class="statusbar-right">skills.sh</span>
        {/if}
      </div>
    </main>

    {#if activeTab !== 'memory'}
      <RightMemoryPanel
        totalCount={data.memoryStats?.total ?? 0}
        memories={memoryDocs}
      />
    {/if}
  </div>
</div>

<style>
  /* === Layout === */

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--color-bg);
    color: var(--color-text);
    overflow: hidden;
  }

  .main {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* === Header === */

  :global(.header) {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    align-items: center;
    height: 44px;
    padding: 0 var(--space-md);
    border-bottom: 1px solid var(--color-border-strong);
    flex-shrink: 0;
    background: var(--color-surface);
  }

  :global(.brand) {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  :global(.brand-crosshair) {
    width: 10px;
    height: 10px;
    position: relative;
    flex-shrink: 0;
  }
  :global(.brand-crosshair::before) {
    content: '';
    position: absolute;
    width: 1px;
    height: 100%;
    left: 50%;
    background: var(--color-accent);
  }
  :global(.brand-crosshair::after) {
    content: '';
    position: absolute;
    width: 100%;
    height: 1px;
    top: 50%;
    background: var(--color-accent);
  }

  :global(.brand-name) {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-text-bright);
  }

  :global(.brand-sep) {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--color-text-muted);
  }

  :global(.brand-sub) {
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  :global(.header-center) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  :global(.header-stat) { color: var(--color-text); }
  :global(.header-divider) { color: var(--color-border-strong); }

  :global(.header-right) {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-sm);
  }

  :global(.daemon-status) {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  :global(.daemon-dot) {
    width: 5px;
    height: 5px;
    border: 1px solid var(--color-text-muted);
    border-radius: 0;
  }

  :global(.daemon-dot-live) {
    background: var(--color-success);
    border-color: var(--color-success);
  }

  :global(.daemon-label) { color: var(--color-text-muted); }

  :global(.btn-icon) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: var(--color-text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0;
    cursor: pointer;
    transition: color var(--dur), border-color var(--dur);
  }

  :global(.btn-icon:hover) {
    color: var(--color-text);
    border-color: var(--color-border);
  }

  /* === Sidebars === */

  :global(.sidebar) {
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    overflow: hidden;
    flex-shrink: 0;
  }

  :global(.sidebar-left) {
    width: 220px;
    border-right: 1px solid var(--color-border-strong);
    position: relative;
  }

  :global(.sidebar-left::before) {
    content: 'SIGNET//CONFIG';
    position: absolute;
    left: 2px;
    top: 50%;
    transform: translateY(-50%) rotate(180deg);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    font-family: var(--font-mono);
    font-size: 6px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-border-strong);
    pointer-events: none;
    z-index: 0;
  }

  :global(.sidebar-right) {
    width: 300px;
    border-left: 1px solid var(--color-border-strong);
  }

  :global(.section) { padding: var(--space-sm) var(--space-sm); }

  :global(.section-panel) {
    position: relative;
    border-bottom: 1px solid var(--color-border);
  }

  :global(.section-panel::before) {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 6px; height: 6px;
    border-top: 1px solid var(--color-border-strong);
    border-left: 1px solid var(--color-border-strong);
    pointer-events: none;
  }

  :global(.section-grow) {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: none;
  }

  :global(.section-header) {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }

  :global(.section-index) {
    font-family: var(--font-mono);
    font-size: 8px;
    color: var(--color-border-strong);
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }

  :global(.section-title) {
    font-family: var(--font-display);
    font-size: 8px;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    flex: 1;
  }

  :global(.agent-card) { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 8px; }
  :global(.agent-name) { font-family: var(--font-display); font-size: 15px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-text-bright); line-height: 1.1; }
  :global(.agent-creature) { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); letter-spacing: 0.04em; }
  :global(.agent-stats) { display: flex; gap: var(--space-md); margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--color-border); }
  :global(.agent-stat) { display: flex; flex-direction: column; gap: 1px; }
  :global(.agent-stat-value) { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--color-text-bright); line-height: 1; letter-spacing: -0.01em; }
  :global(.agent-stat-label) { font-family: var(--font-mono); font-size: 7px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-text-muted); }

  :global(.harness-row) { display: flex; align-items: center; gap: var(--space-sm); padding: 4px 0; }
  :global(.harness-name) { font-family: var(--font-mono); font-size: 11px; color: var(--color-text); flex: 1; }
  :global(.harness-badge) { font-family: var(--font-mono); font-size: 7px; letter-spacing: 0.1em; color: var(--color-text-muted); }
  :global(.harness-row:has(.seal-status-active) .harness-badge) { color: var(--color-success); }

  :global(.seal-indicator) { width: 8px; height: 8px; position: relative; flex-shrink: 0; }
  :global(.seal-indicator::before) { content: ''; position: absolute; width: 1px; height: 100%; left: 50%; background: var(--color-accent); }
  :global(.seal-indicator::after) { content: ''; position: absolute; width: 100%; height: 1px; top: 50%; background: var(--color-accent); }

  :global(.seal-status) { width: 6px; height: 6px; position: relative; flex-shrink: 0; }
  :global(.seal-status::before) { content: ''; position: absolute; width: 1px; height: 100%; left: 50%; background: var(--color-text-muted); }
  :global(.seal-status::after) { content: ''; position: absolute; width: 100%; height: 1px; top: 50%; background: var(--color-text-muted); }
  :global(.seal-status-active::before), :global(.seal-status-active::after) { background: var(--color-success); }

  :global(.file-list) { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
  :global(.file-item) { display: flex; align-items: center; justify-content: space-between; padding: var(--space-sm) var(--space-sm); font-size: 12px; color: var(--color-text); background: transparent; border: none; border-radius: 0; cursor: pointer; text-align: left; }
  :global(.file-item:hover) { background: var(--color-surface-raised); color: var(--color-text-bright); }
  :global(.file-item-active) { background: var(--color-surface-raised); color: var(--color-text-bright); border-left: 2px solid var(--color-text-bright); }
  :global(.file-name) { font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.file-meta) { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); flex-shrink: 0; }

  /* === Center Panel === */

  .center { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--color-bg); }

  .tabs { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--color-border-strong); flex-shrink: 0; }
  .tab-group { display: flex; gap: 0; }
  .tab { padding: 0 16px; height: 44px; font-family: var(--font-mono); font-size: 9px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-text-muted); background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer; transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease); }
  .tab:hover { color: var(--color-text); }
  .tab-active { color: var(--color-text-bright); border-bottom-color: var(--color-text-bright); }
  .tab-info { display: flex; align-items: center; gap: 12px; }
  :global(.status-text) { font-size: 11px; color: var(--color-text-muted); }

  :global(.btn-text) { font-size: 11px; color: var(--color-accent); background: transparent; border: none; cursor: pointer; padding: 0; }
  :global(.btn-text:hover) { text-decoration: underline; }
  :global(.btn-primary) { padding: var(--space-xs) 12px; font-size: 11px; font-weight: 500; color: var(--color-bg); background: var(--color-text-bright); border: none; border-radius: 0; cursor: pointer; }
  :global(.btn-primary:hover) { background: var(--color-text); }
  :global(.btn-primary:disabled) { opacity: 0.4; cursor: default; }

  .content { flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; }

  /* === Editor === */
  :global(.editor-chrome) { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 var(--space-md); border-bottom: 1px solid var(--color-border); flex-shrink: 0; background: var(--color-surface); }
  :global(.editor-breadcrumb) { font-family: var(--font-mono); font-size: 11px; }
  :global(.editor-path) { color: var(--color-text-muted); }
  :global(.editor-filename) { color: var(--color-text-bright); }
  :global(.editor-actions) { display: flex; align-items: center; gap: var(--space-sm); }
  :global(.editor-saved) { font-family: var(--font-mono); font-size: 8px; letter-spacing: 0.1em; color: var(--color-success); }
  :global(.btn-editor-save) { font-family: var(--font-mono); font-size: 9px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-bright); background: transparent; border: 1px solid var(--color-border-strong); border-radius: 0; padding: 3px 10px; cursor: pointer; transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease); }
  :global(.btn-editor-save:hover:not(:disabled)) { background: var(--color-text-bright); color: var(--color-bg); border-color: var(--color-text-bright); }
  :global(.btn-editor-save:disabled) { opacity: 0.4; cursor: default; }
  :global(.editor) { flex: 1; width: 100%; padding: 20px; font-family: var(--font-mono); font-size: 12px; line-height: 1.8; color: var(--color-text-bright); background: var(--color-bg); border: none; resize: none; outline: none; tab-size: 2; }
  :global(.editor::placeholder) { color: var(--color-text-muted); font-style: italic; }

  /* === Memory Library === */
  :global(.memory-library) { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: var(--space-md); background: var(--color-bg); }
  :global(.memory-library-toolbar) { display: flex; align-items: center; gap: 12px; }
  :global(.memory-search-shell) { flex: 1; display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) 12px; border-radius: 0; border: 1px solid var(--color-border-strong); background: var(--color-surface-raised); }
  :global(.memory-search-glyph) { color: var(--color-accent); font-family: var(--font-mono); font-size: 11px; }
  :global(.memory-library-search) { flex: 1; font-size: 13px; font-family: var(--font-mono); color: var(--color-text-bright); background: transparent; border: none; outline: none; }
  :global(.memory-library-search::placeholder) { color: var(--color-text-muted); }
  :global(.memory-toolbar-clear) { white-space: nowrap; }
  :global(.memory-library-filters) { display: grid; grid-template-columns: minmax(140px, 200px) minmax(180px, 1fr) 90px 140px auto; gap: var(--space-sm); align-items: center; }
  :global(.memory-filter-select), :global(.memory-filter-input), :global(.memory-filter-number), :global(.memory-filter-date) { width: 100%; font-size: 12px; font-family: var(--font-mono); color: var(--color-text-bright); background: var(--color-surface-raised); border: 1px solid var(--color-border-strong); border-radius: 0; padding: 6px 8px; outline: none; }
  :global(.memory-filter-pill) { font-size: 11px; font-family: var(--font-mono); color: var(--color-text); background: transparent; border: 1px solid var(--color-border-strong); border-radius: 0; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
  :global(.memory-filter-pill-active) { color: var(--color-accent); border-color: var(--color-accent); background: rgba(138, 138, 150, 0.1); }
  :global(.memory-library-types) { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
  :global(.memory-type-chip) { font-size: 9px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.12em; color: var(--color-text-muted); background: transparent; border: 1px solid var(--color-border-strong); border-radius: 0; padding: 4px 10px; cursor: pointer; transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease); }
  :global(.memory-type-chip-active) { color: var(--color-accent); border-color: var(--color-accent); background: rgba(138, 138, 150, 0.1); }
  :global(.memory-similar-banner) { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: var(--space-sm) 12px; border-radius: 0; border: 1px dashed var(--color-border-strong); font-family: var(--font-mono); font-size: 11px; color: var(--color-text); background: var(--color-surface); }
  :global(.memory-doc-grid) { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; padding-right: var(--space-xs); }
  :global(.memory-doc) { position: relative; display: flex; flex-direction: column; min-height: 180px; max-height: 320px; gap: 10px; padding: var(--space-md); border-radius: 0; border: 1px solid var(--color-border-strong); border-top-width: 2px; border-top-color: var(--color-text-muted); background: var(--color-surface); overflow: hidden; transition: border-color var(--dur) var(--ease); }
  :global(.memory-doc:hover) { border-color: var(--color-text-muted); }
  :global(.memory-doc::before), :global(.memory-doc::after) { content: ''; position: absolute; width: 6px; height: 6px; border-color: var(--color-border-strong); border-style: solid; pointer-events: none; transition: border-color var(--dur) var(--ease); }
  :global(.memory-doc::before) { top: -1px; left: -1px; border-width: 1px 0 0 1px; }
  :global(.memory-doc::after) { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
  :global(.memory-doc:hover::before), :global(.memory-doc:hover::after) { border-color: var(--color-text-muted); }
  :global(.memory-doc-head) { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-sm); }
  :global(.memory-doc-stamp) { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  :global(.memory-doc-date) { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); white-space: nowrap; }
  :global(.memory-doc-content) { margin: 0; color: var(--color-text-bright); line-height: 1.62; font-size: 12px; white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; }
  :global(.memory-doc-tags) { display: flex; flex-wrap: wrap; gap: 6px; }
  :global(.memory-doc-tag), :global(.memory-doc-type), :global(.memory-doc-pin), :global(.memory-doc-importance), :global(.memory-doc-match), :global(.memory-doc-source) { font-family: var(--font-mono); font-size: 10px; border-radius: 0; padding: 2px 7px; border: 1px solid var(--color-border-strong); color: var(--color-text); background: rgba(255, 255, 255, 0.04); }
  :global(.memory-doc-source) { color: var(--color-accent); border-color: var(--color-accent); background: transparent; }
  :global(.memory-doc-pin) { color: var(--color-text-bright); border-color: var(--color-border-strong); background: rgba(255, 255, 255, 0.06); }
  :global(.memory-doc-match) { color: var(--color-accent); }
  :global(.memory-doc-foot) { display: flex; align-items: center; gap: var(--space-sm); margin-top: auto; }
  :global(.btn-similar) { opacity: 0; font-size: 13px; color: var(--color-text-muted); background: none; border: none; cursor: pointer; margin-left: auto; padding: 0 2px; line-height: 1; transition: opacity 0.1s, color 0.1s; }
  :global(.btn-similar-visible) { opacity: 1; margin-left: auto; border: 1px solid var(--color-border-strong); border-radius: 0; padding: 3px 8px; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
  :global(.memory-item:hover .btn-similar) { opacity: 1; }
  :global(.btn-similar:hover) { color: var(--color-accent); }
  :global(.memory-library-empty) { border: 1px dashed var(--color-border-strong); border-radius: 0; background: transparent; }

  /* === Embeddings === */
  :global(.embeddings-layout) { flex: 1; min-height: 0; display: flex; background: #050505; }
  :global(.canvas-container) { flex: 1; position: relative; overflow: hidden; background: #050505; }
  :global(.graph-toolbar) { position: absolute; top: 8px; left: 12px; right: 12px; z-index: 8; display: flex; align-items: center; gap: var(--space-sm); pointer-events: none; }
  :global(.graph-toolbar-input) { flex: 1; max-width: 420px; pointer-events: auto; font-family: var(--font-mono); font-size: 11px; color: var(--color-text-bright); background: var(--color-surface); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 0; padding: 6px 9px; outline: none; }
  :global(.graph-toolbar-meta) { font-family: var(--font-mono); font-size: 10px; color: rgba(220, 220, 220, 0.75); background: rgba(5, 5, 5, 0.55); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 0; padding: 4px 8px; }
  :global(.graph-ascii) { position: absolute; left: 14px; top: 44px; z-index: 6; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); letter-spacing: 0.08em; text-transform: uppercase; pointer-events: none; }
  :global(.graph-corners) { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
  :global(.corner) { position: absolute; width: 14px; height: 14px; border-color: rgba(255, 255, 255, 0.22); border-style: solid; }
  :global(.corner-tl) { top: 10px; left: 10px; border-width: 1px 0 0 1px; }
  :global(.corner-tr) { top: 10px; right: 10px; border-width: 1px 1px 0 0; }
  :global(.corner-bl) { bottom: 10px; left: 10px; border-width: 0 0 1px 1px; }
  :global(.corner-br) { bottom: 10px; right: 10px; border-width: 0 1px 1px 0; }
  :global(.canvas) { width: 100%; height: 100%; cursor: grab; }
  :global(.graph3d-container) { position: absolute; inset: 0; }
  :global(.embedding-inspector) { width: 340px; min-width: 300px; border-left: 1px solid var(--color-border); background: var(--color-surface); display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow-y: auto; }
  :global(.embedding-inspector-header) { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
  :global(.embedding-inspector-title) { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text); }
  :global(.embedding-inspector-meta) { display: flex; flex-wrap: wrap; gap: 6px; }
  :global(.embedding-inspector-meta span), :global(.embedding-inspector-tags span) { font-family: var(--font-mono); font-size: 10px; color: var(--color-text); border: 1px solid var(--color-border-strong); border-radius: 0; padding: 2px 7px; background: rgba(255, 255, 255, 0.04); }
  :global(.embedding-inspector-source) { font-family: var(--font-mono); font-size: 10px; color: var(--color-accent); border: 1px solid var(--color-border-strong); border-radius: 0; padding: 5px 7px; background: transparent; word-break: break-all; }
  :global(.embedding-inspector-content) { margin: 0; font-size: 13px; line-height: 1.55; color: var(--color-text-bright); white-space: pre-wrap; word-break: break-word; }
  :global(.embedding-inspector-tags) { display: flex; flex-wrap: wrap; gap: 6px; }
  :global(.embedding-inspector-actions) { display: flex; gap: var(--space-sm); }
  :global(.embedding-inspector-subtitle) { font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); letter-spacing: 0.04em; text-transform: uppercase; }
  :global(.embedding-inspector-empty) { border: 1px dashed var(--color-border-strong); border-radius: 0; padding: 12px; font-size: 12px; color: var(--color-text-muted); line-height: 1.5; }
  :global(.embedding-mode-toggle) { align-self: flex-start; }
  :global(.embedding-relation-list) { display: flex; flex-direction: column; gap: var(--space-sm); }
  :global(.embedding-relation-item) { display: grid; grid-template-columns: auto 1fr; gap: var(--space-sm); align-items: start; width: 100%; text-align: left; border: 1px solid var(--color-border-strong); border-radius: 0; background: rgba(255, 255, 255, 0.03); color: var(--color-text); padding: 7px 8px; cursor: pointer; }
  :global(.embedding-relation-item:hover) { border-color: var(--color-text-muted); background: var(--color-surface-raised); }
  :global(.embedding-relation-score) { font-family: var(--font-mono); font-size: 10px; color: var(--color-accent); white-space: nowrap; }
  :global(.embedding-relation-text) { font-size: 12px; line-height: 1.45; color: var(--color-text-bright); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  :global(.embedding-limit-shell) { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 10px; color: var(--color-text-muted); }
  :global(.embedding-limit-input) { width: 72px; font-family: var(--font-mono); font-size: 11px; color: var(--color-text-bright); background: var(--color-surface-raised); border: 1px solid var(--color-border-strong); border-radius: 0; padding: 4px 6px; outline: none; }
  :global(.mode-toggle) { display: flex; border: 1px solid var(--color-border-strong); border-radius: 0; overflow: hidden; }
  :global(.mode-btn) { padding: 2px 8px; font-size: 10px; font-weight: 500; font-family: var(--font-mono); color: var(--color-text-muted); background: transparent; border: none; cursor: pointer; letter-spacing: 0.04em; }
  :global(.mode-btn:hover) { color: var(--color-text); background: var(--color-surface-raised); }
  :global(.mode-btn-active) { color: var(--color-text-bright); background: var(--color-surface-raised); }
  :global(.overlay) { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--color-bg); z-index: 10; }
  :global(.overlay p) { font-size: 13px; color: var(--color-text); }
  :global(.btn-primary-small) { padding: 4px 12px; font-family: var(--font-mono); font-size: 9px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; background: transparent; border: 1px solid var(--color-text-bright); color: var(--color-text-bright); border-radius: 0; cursor: pointer; transition: background var(--dur) var(--ease), color var(--dur) var(--ease); }
  :global(.btn-primary-small:hover:not(:disabled)) { background: var(--color-text-bright); color: var(--color-bg); }
  :global(.btn-primary-small:disabled) { opacity: 0.4; cursor: not-allowed; }

  /* === Status Bar === */
  .statusbar { display: flex; background: var(--color-surface); align-items: center; justify-content: space-between; height: 26px; padding: 0 12px; border-top: 1px solid var(--color-border); font-size: 10px; font-family: var(--font-mono); color: var(--color-text-muted); flex-shrink: 0; }
  .statusbar-right { display: flex; align-items: center; gap: var(--space-sm); }
  .statusbar kbd { padding: 1px 4px; font-size: 9px; color: var(--color-text-muted); background: var(--color-surface-raised); border-radius: 0; }

  /* === Right Sidebar === */
  :global(.badge) { font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-muted); padding: 2px 6px; background: transparent; border: 1px solid var(--color-border-strong); border-radius: 0; }
  :global(.search-row) { display: flex; align-items: center; gap: var(--space-xs); }
  :global(.search-input) { flex: 1; padding: var(--space-sm) 12px; font-size: 12px; font-family: var(--font-mono); color: var(--color-text-bright); background: var(--color-surface); border: 1px solid var(--color-border-strong); border-radius: 0; outline: none; }
  :global(.search-input:focus) { border-color: var(--color-border-strong); }
  :global(.search-input::placeholder) { color: var(--color-text-muted); }
  :global(.search-results) { font-size: 11px; color: var(--color-text-muted); margin-top: var(--space-sm); }
  :global(.memory-scroll) { flex: 1; overflow-y: auto; padding: 0 12px var(--space-md); }
  :global(.memory-item) { padding: 12px 0; border-bottom: 1px solid var(--color-border); }
  :global(.memory-item:last-child) { border-bottom: none; }
  :global(.memory-content) { font-size: 12px; line-height: 1.6; color: var(--color-text); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin: 0 0 var(--space-sm) 0; }
  :global(.memory-footer) { display: flex; align-items: center; gap: var(--space-sm); font-size: 10px; }
  :global(.memory-source) { font-family: var(--font-mono); color: var(--color-accent); }
  :global(.memory-critical) { color: var(--color-accent); font-weight: 500; text-transform: uppercase; letter-spacing: 0.02em; }
  :global(.memory-time) { color: var(--color-text-muted); font-family: var(--font-mono); }
  :global(.memory-type) { font-family: var(--font-mono); font-size: 9px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 0; padding: 0 3px; }
  :global(.memory-pinned) { font-size: 9px; }
  :global(.empty) { padding: var(--space-xl) var(--space-md); text-align: center; font-size: 13px; color: var(--color-text-muted); }
  :global(.filter-panel) { display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm) 0; border-top: 1px solid var(--color-border); }
  :global(.filter-row) { display: flex; gap: var(--space-xs); align-items: center; flex-wrap: wrap; }
  :global(.pill) { font-size: 10px; padding: 2px 6px; border-radius: 0; border: 1px solid var(--color-border-strong); background: none; color: var(--color-text); cursor: pointer; white-space: nowrap; }
  :global(.pill:hover) { border-color: var(--color-accent); color: var(--color-accent); }
  :global(.pill-active) { border-color: var(--color-accent); color: var(--color-accent); background: rgba(138, 138, 150, 0.1); }
  :global(.filter-select), :global(.filter-input) { font-size: 11px; font-family: var(--font-mono); background: var(--color-surface-raised); border: 1px solid var(--color-border-strong); color: var(--color-text-bright); border-radius: 0; padding: 3px 6px; width: 100%; outline: none; }
  :global(.filter-num) { font-size: 11px; font-family: var(--font-mono); background: var(--color-surface-raised); border: 1px solid var(--color-border-strong); color: var(--color-text-bright); border-radius: 0; padding: 3px 4px; width: 48px; outline: none; }
  :global(.filter-date) { font-size: 11px; font-family: var(--font-mono); background: var(--color-surface-raised); border: 1px solid var(--color-border-strong); color: var(--color-text-bright); border-radius: 0; padding: 3px 4px; flex: 1; outline: none; }
  :global(.filter-label) { font-size: 10px; color: var(--color-text-muted); white-space: nowrap; font-family: var(--font-mono); }
  :global(.filter-active) { color: var(--color-accent) !important; }
  :global(.similar-header) { font-size: 11px; color: var(--color-text); padding: var(--space-sm) 0 0; display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-sm); font-family: var(--font-mono); line-height: 1.4; }
  :global(.text-error) { color: var(--color-danger); }

  /* === Logs === */
  :global(.logs-container) { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  :global(.logs-filters) { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) 12px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  :global(.logs-filters .filter-select) { font-size: 11px; padding: 4px 8px; min-width: 100px; }
  :global(.checkbox-label) { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--color-text); cursor: pointer; }
  :global(.checkbox-label input) { margin: 0; }
  :global(.streaming-indicator) { color: var(--color-success); font-size: 11px; font-weight: 500; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  :global(.streaming-badge) { background: transparent; border: 1px solid var(--color-success); color: var(--color-success); font-family: var(--font-mono); font-size: 8px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 6px; border-radius: 0; animation: pulse 2s infinite; }
  :global(.logs-scroll) { flex: 1; overflow-y: auto; padding: var(--space-sm); font-family: var(--font-mono); font-size: 11px; line-height: 1.6; }
  :global(.logs-empty) { padding: var(--space-xl); text-align: center; color: var(--color-text-muted); font-family: var(--font-display); font-size: 13px; }
  :global(.log-entry) { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs); padding: 2px 0; border-bottom: 1px solid var(--color-border); }
  :global(.log-entry:last-child) { border-bottom: none; }
  :global(.log-time) { color: var(--color-text-muted); flex-shrink: 0; }
  :global(.log-level) { font-weight: 600; flex-shrink: 0; min-width: 40px; }
  :global(.log-debug .log-level) { color: var(--color-text-muted); }
  :global(.log-info .log-level) { color: var(--color-accent); }
  :global(.log-warn .log-level) { color: var(--color-accent); }
  :global(.log-error .log-level) { color: var(--color-danger); }
  :global(.log-category) { color: var(--color-text); flex-shrink: 0; }
  :global(.log-message) { color: var(--color-text-bright); }
  :global(.log-duration) { color: var(--color-text-muted); }
  :global(.log-data) { color: var(--color-text-muted); font-size: 10px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.log-error) { width: 100%; color: var(--color-danger); padding-left: 60px; font-size: 10px; }
  :global(.btn-icon.streaming) { color: var(--color-success); }

  /* === Secrets === */
  :global(.secrets-container) { height: 100%; display: flex; flex-direction: column; padding: 16px; gap: 16px; overflow: hidden; }
  :global(.secrets-add) { display: flex; gap: 8px; flex-shrink: 0; }
  :global(.secrets-input) { flex: 1; padding: 8px 12px; border: 1px solid var(--color-border-strong); border-radius: 0; background: var(--color-surface-raised); color: var(--color-text-bright); font-size: 13px; }
  :global(.secrets-input:focus) { outline: none; border-color: var(--color-accent); }
  :global(.secrets-list) { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  :global(.secrets-empty) { padding: 32px; text-align: center; color: var(--color-text-muted); }
  :global(.secret-item) { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--color-surface-raised); border-radius: 0; border: 1px solid var(--color-border-strong); }
  :global(.secret-name) { flex: 1; font-family: var(--font-mono); font-size: 13px; color: var(--color-text-bright); }
  :global(.secret-value) { color: var(--color-text-muted); font-family: var(--font-mono); font-size: 12px; }
  :global(.btn-danger-small) { padding: 4px 10px; font-size: 11px; background: transparent; border: 1px solid var(--color-danger); color: var(--color-danger); border-radius: 0; cursor: pointer; }
  :global(.btn-danger-small:hover:not(:disabled)) { background: var(--color-danger); color: var(--color-text-bright); }
  :global(.btn-danger-small:disabled) { opacity: 0.5; cursor: not-allowed; }

  /* === Skills === */
  :global(.skills-container) { height: 100%; display: flex; flex-direction: column; padding: 16px; gap: 16px; overflow: hidden; }
  :global(.skills-search) { display: flex; gap: 8px; flex-shrink: 0; }
  :global(.skills-search-input) { flex: 1; padding: 8px 12px; border: 1px solid var(--color-border-strong); border-radius: 0; background: var(--color-surface-raised); color: var(--color-text-bright); font-size: 13px; }
  :global(.skills-search-input:focus) { outline: none; border-color: var(--color-accent); }
  :global(.skills-section) { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
  :global(.skills-section-title) { font-family: var(--font-display); font-size: 9px; font-weight: 600; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.14em; flex-shrink: 0; }
  :global(.skills-list) { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  :global(.skills-empty) { padding: 32px; text-align: center; color: var(--color-text-muted); }
  :global(.skill-item) { padding: 12px 16px; background: var(--color-surface-raised); border-radius: 0; border: 1px solid var(--color-border-strong); display: flex; flex-direction: column; gap: 6px; }
  :global(.skill-item.skill-selected) { border-color: var(--color-accent); }
  :global(.skill-info) { display: flex; align-items: center; gap: 8px; }
  :global(.skill-name) { font-family: var(--font-display); font-size: 12px; font-weight: 600; color: var(--color-text-bright); text-transform: uppercase; letter-spacing: 0.04em; }
  :global(.skill-badge) { font-family: var(--font-mono); font-size: 8px; padding: 2px 6px; border-radius: 0; text-transform: uppercase; letter-spacing: 0.1em; border: 1px solid; background: transparent; }
  :global(.skill-badge.installed) { border-color: var(--color-success); color: var(--color-success); }
  :global(.skill-badge.builtin) { border-color: var(--color-accent); color: var(--color-accent); }
  :global(.skill-badge.invocable) { border-color: var(--color-border-strong); color: var(--color-text-muted); }
  :global(.skill-description) { font-size: 12px; color: var(--color-text); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  :global(.skill-actions) { display: flex; gap: 8px; margin-top: 4px; }

  /* === Responsive === */
  @media (max-width: 1024px) {
    :global(.sidebar-right) { display: none; }
    :global(.embeddings-layout) { flex-direction: column; }
    :global(.embedding-inspector) { width: 100%; min-width: 0; max-height: 42%; border-left: none; border-top: 1px solid var(--color-border); }
    :global(.memory-library) { padding: 12px; }
    :global(.memory-library-filters) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 768px) {
    :global(.sidebar-left) { display: none; }
    .tabs { overflow-x: auto; justify-content: flex-start; gap: var(--space-sm); }
    .tab-info { margin-left: auto; flex-shrink: 0; gap: var(--space-sm); }
    :global(.embedding-limit-shell) { display: none; }
    :global(.memory-library-toolbar) { flex-direction: column; align-items: stretch; }
    :global(.memory-library-filters) { grid-template-columns: 1fr; }
    :global(.memory-doc-grid) { grid-template-columns: 1fr; }
  }

  /* === Background decorative layer === */
  :global(.bg-field) { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
  .app > :global(*:not(.bg-field)) { position: relative; z-index: 1; }
  :global(.bleed-text) { position: absolute; top: -0.1em; right: -0.04em; font-family: var(--font-display); font-size: 18rem; font-weight: 700; letter-spacing: -0.02em; color: var(--color-text-bright); opacity: 0.025; user-select: none; }
  :global(.fp) { position: absolute; background: var(--color-surface); border: 1px solid var(--color-border); animation: fp-drift ease-in-out infinite alternate; opacity: 0.2; }
  :global(.fp-1) { width: 180px; height: 80px; top: 15%; left: 5%; animation-duration: 52s; }
  :global(.fp-2) { width: 120px; height: 200px; top: 45%; right: 8%; animation-duration: 64s; animation-delay: -20s; }
  :global(.fp-3) { width: 240px; height: 60px; bottom: 20%; left: 30%; animation-duration: 41s; animation-delay: -8s; }
  :global(.fp-4) { width: 100px; height: 140px; top: 25%; left: 40%; animation-duration: 58s; animation-delay: -35s; opacity: 0.12; }
  :global(.mf) { position: absolute; font-family: var(--font-mono); font-size: 7px; letter-spacing: 0.12em; color: var(--color-text-muted); text-transform: uppercase; animation: mf-flicker ease-in-out infinite; opacity: 0.35; }
  :global(.mf-1) { top: 12%; left: 8%; animation-duration: 11s; }
  :global(.mf-2) { top: 68%; left: 3%; animation-duration: 8s; animation-delay: -3s; }
  :global(.mf-3) { top: 38%; right: 5%; animation-duration: 14s; animation-delay: -6s; }
  :global(.mf-4) { bottom: 8%; right: 12%; animation-duration: 9s; animation-delay: -2s; }
  :global(.ch-node) { position: absolute; width: 10px; height: 10px; }
  :global(.ch-node::before), :global(.ch-node::after) { content: ''; position: absolute; background: var(--color-text-muted); opacity: 0.6; }
  :global(.ch-node::before) { width: 1px; height: 100%; left: 50%; }
  :global(.ch-node::after) { width: 100%; height: 1px; top: 50%; }
  :global(#bg-ch-0) { top: 18%; left: 12%; }
  :global(#bg-ch-1) { top: 22%; left: 20%; }
  :global(#bg-ch-2) { top: 15%; left: 28%; }
  :global(#bg-ch-3) { top: 28%; left: 15%; }
  :global(#bg-ch-4) { top: 12%; left: 62%; }
  :global(#bg-ch-5) { top: 18%; right: 15%; }
  :global(#bg-ch-6) { top: 52%; left: 8%; }
  :global(#bg-ch-7) { top: 48%; left: 16%; }
  :global(#bg-ch-8) { top: 60%; left: 12%; }
  :global(#bg-ch-9) { bottom: 30%; left: 32%; }
  :global(#bg-ch-10) { bottom: 22%; left: 55%; }
  :global(#bg-ch-11) { bottom: 15%; right: 20%; }
  :global(.sc-hub) { position: absolute; width: 28px; height: 28px; border: 1px solid var(--color-text-muted); border-radius: 50%; opacity: 0.4; animation: node-pulse ease-in-out infinite; }
  :global(.sc-hub::before), :global(.sc-hub::after) { content: ''; position: absolute; background: var(--color-text-muted); }
  :global(.sc-hub::before) { width: 1px; height: 100%; left: 50%; top: 0; }
  :global(.sc-hub::after) { width: 100%; height: 1px; top: 50%; left: 0; }
  :global(.sc-hub-1) { top: 22%; left: 22%; animation-duration: 6s; }
  :global(.sc-hub-2) { top: 52%; left: 68%; animation-duration: 8s; animation-delay: -2s; }
  :global(.sc-hub-3) { bottom: 22%; left: 42%; animation-duration: 7s; animation-delay: -4s; }
  :global(.conn-svg) { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>
