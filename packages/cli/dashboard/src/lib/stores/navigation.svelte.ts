/**
 * Shared navigation state for the dashboard.
 *
 * Active tab is synced to location.hash for refresh persistence
 * and browser back/forward support.
 */

import { confirmDiscardChanges } from "$lib/stores/unsaved-changes.svelte";

export type TabId =
	| "home"
	| "settings"
	| "memory"
	| "timeline"
	| "knowledge"
	| "embeddings"
	| "pipeline"
	| "logs"
	| "secrets"
	| "skills"
	| "tasks"
	| "connectors"
	| "predictor"
	| "changelog"
	| "os"
	| "cortex-memory"
	| "cortex-apps"
	| "cortex-tasks"
	| "cortex-troubleshooter";

const VALID_TABS: ReadonlySet<string> = new Set<TabId>([
	"home",
	"settings",
	"memory",
	"timeline",
	"knowledge",
	"embeddings",
	"pipeline",
	"logs",
	"secrets",
	"skills",
	"tasks",
	"connectors",
	"predictor",
	"changelog",
	"os",
	"cortex-memory",
	"cortex-apps",
	"cortex-tasks",
	"cortex-troubleshooter",
]);

// Alias map for path-style hashes (e.g. #memory/constellation -> embeddings)
const HASH_ALIASES: ReadonlyMap<string, TabId> = new Map([
	["memory/constellation", "cortex-memory"],
	["memory/timeline", "cortex-memory"],
	["memory/knowledge", "cortex-memory"],
	["memory/memories", "cortex-memory"],
	["cortex", "cortex-memory"],
	["cortex/memory", "cortex-memory"],
	["cortex/apps", "cortex-apps"],
	["cortex/tasks", "cortex-tasks"],
	["cortex/troubleshooter", "cortex-troubleshooter"],
	["cortex-memory/constellation", "cortex-memory"],
	["cortex-memory/timeline", "cortex-memory"],
	["cortex-memory/knowledge", "cortex-memory"],
	["matt", "cortex-memory"],
	["matt/memory", "cortex-memory"],
	["matt/apps", "cortex-apps"],
	["matt/tasks", "cortex-tasks"],
	["matt/troubleshooter", "cortex-troubleshooter"],
	["engine/settings", "settings"],
	["engine/pipeline", "pipeline"],
	["engine/predictor", "predictor"],
	["engine/connectors", "connectors"],
	["engine/logs", "logs"],
	["config", "settings"],
]);

function readTabFromHash(): TabId | null {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash.slice(1);
	if (VALID_TABS.has(hash)) return hash as TabId;
	return HASH_ALIASES.get(hash) ?? null;
}

export const nav = $state({
	activeTab: "home" as TabId,
});

/* ── Tab groups (display-layer only) ── */

const MEMORY_TABS: ReadonlySet<TabId> = new Set([
	"memory",
	"timeline",
	"knowledge",
	"embeddings",
]);
const ENGINE_TABS: ReadonlySet<TabId> = new Set([
	"settings",
	"pipeline",
	"predictor",
	"connectors",
	"logs",
]);
const CORTEX_TABS: ReadonlySet<TabId> = new Set([
	"cortex-memory",
	"cortex-apps",
	"cortex-tasks",
	"cortex-troubleshooter",
]);

export type NavGroup = "memory" | "engine" | "cortex";

const lastMemoryTab = $state({ value: "memory" as TabId });
const lastEngineTab = $state({ value: "settings" as TabId });
const lastCortexTab = $state({ value: "cortex-memory" as TabId });

export function isMemoryGroup(tab: TabId): boolean {
	return MEMORY_TABS.has(tab);
}
export function isEngineGroup(tab: TabId): boolean {
	return ENGINE_TABS.has(tab);
}
export function isCortexGroup(tab: TabId): boolean {
	return CORTEX_TABS.has(tab);
}

export function setTab(tab: TabId): boolean {
	if (tab === nav.activeTab) return true;
	if (!confirmDiscardChanges(`switch to ${tab}`)) return false;
	nav.activeTab = tab;
	if (MEMORY_TABS.has(tab)) lastMemoryTab.value = tab;
	if (ENGINE_TABS.has(tab)) lastEngineTab.value = tab;
	if (CORTEX_TABS.has(tab)) lastCortexTab.value = tab;
	if (typeof window !== "undefined") {
		history.replaceState(null, "", `#${tab}`);
	}
	return true;
}

export function navigateToGroup(group: NavGroup): boolean {
	if (group === "cortex") return setTab(lastCortexTab.value);
	const tab =
		group === "memory" ? lastMemoryTab.value : lastEngineTab.value;
	return setTab(tab);
}

/**
 * Read initial tab from URL hash and listen for hashchange events.
 * Call from onMount in the root page component.
 * Returns a cleanup function to remove the event listener.
 */
export function initNavFromHash(): () => void {
	const initial = readTabFromHash();
	if (initial) {
		nav.activeTab = initial;
	} else if (typeof window !== "undefined") {
		// No hash present — set it to the default tab
		history.replaceState(null, "", `#${nav.activeTab}`);
	}

	const onHashChange = () => {
		const tab = readTabFromHash();
		if (tab && tab !== nav.activeTab) nav.activeTab = tab;
	};
	window.addEventListener("hashchange", onHashChange);
	return () => window.removeEventListener("hashchange", onHashChange);
}
