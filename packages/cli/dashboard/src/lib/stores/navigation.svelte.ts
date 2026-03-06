/**
 * Shared navigation state for the dashboard.
 *
 * Active tab is synced to location.hash for refresh persistence
 * and browser back/forward support.
 */

import { confirmDiscardChanges } from "$lib/stores/unsaved-changes.svelte";

export type TabId =
	| "config"
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
	| "connectors";

const VALID_TABS: ReadonlySet<string> = new Set<TabId>([
	"config",
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
]);

function readTabFromHash(): TabId | null {
	if (typeof window === "undefined") return null;
	const hash = window.location.hash.slice(1);
	return VALID_TABS.has(hash) ? (hash as TabId) : null;
}

export const nav = $state({
	activeTab: "config" as TabId,
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
	"connectors",
	"logs",
]);

export type NavGroup = "memory" | "engine";

const lastMemoryTab = $state({ value: "memory" as TabId });
const lastEngineTab = $state({ value: "settings" as TabId });

export function isMemoryGroup(tab: TabId): boolean {
	return MEMORY_TABS.has(tab);
}
export function isEngineGroup(tab: TabId): boolean {
	return ENGINE_TABS.has(tab);
}

export function setTab(tab: TabId): boolean {
	if (tab === nav.activeTab) return true;
	if (!confirmDiscardChanges(`switch to ${tab}`)) return false;
	nav.activeTab = tab;
	if (MEMORY_TABS.has(tab)) lastMemoryTab.value = tab;
	if (ENGINE_TABS.has(tab)) lastEngineTab.value = tab;
	if (typeof window !== "undefined") {
		history.replaceState(null, "", `#${tab}`);
	}
	return true;
}

export function navigateToGroup(group: NavGroup): boolean {
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
