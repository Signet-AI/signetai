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
	| "audit"
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
	"audit",
	"secrets",
	"skills",
	"tasks",
	"changelog",
	"os",
	"cortex-memory",
]);

// Alias map for path-style hashes (e.g. #memory/constellation -> embeddings)
const HASH_ALIASES: ReadonlyMap<string, TabId> = new Map([
	["memory/constellation", "cortex-memory"],
	["memory/timeline", "cortex-memory"],
	["memory/knowledge", "cortex-memory"],
	["memory/memories", "cortex-memory"],
	["ontology", "cortex-memory"],
	["ontology/cortex", "cortex-memory"],
	["ontology/constellation", "cortex-memory"],
	["memory", "cortex-memory"],
	["embeddings", "cortex-memory"],
	["knowledge", "cortex-memory"],
	["cortex", "cortex-memory"],
	["cortex/memory", "cortex-memory"],
	["cortex/apps", "cortex-memory"],
	["cortex/tasks", "tasks"],
	["cortex/troubleshooter", "audit"],
	["cortex-memory/constellation", "cortex-memory"],
	["cortex-memory/timeline", "cortex-memory"],
	["cortex-memory/knowledge", "cortex-memory"],
	["matt", "cortex-memory"],
	["matt/memory", "cortex-memory"],
	["matt/apps", "cortex-memory"],
	["matt/tasks", "tasks"],
	["matt/troubleshooter", "audit"],
	["engine/settings", "settings"],
	["engine/pipeline", "settings"],
	["engine/predictor", "settings"],
	["engine/connectors", "settings"],
	["engine/logs", "audit"],
	["pipeline", "settings"],
	["predictor", "settings"],
	["connectors", "settings"],
	["logs", "audit"],
	["audit/logs", "audit"],
	["audit/troubleshooter", "audit"],
	["cortex-apps", "cortex-memory"],
	["cortex-tasks", "tasks"],
	["cortex-troubleshooter", "audit"],
	["config", "settings"],
	["review-queue", "settings"],
]);

const HASH_CANONICAL: ReadonlyMap<string, string> = new Map([
	["memory/constellation", "cortex-memory/constellation"],
	["ontology/constellation", "cortex-memory/constellation"],
	["cortex-memory/constellation", "cortex-memory/constellation"],
	["memory/timeline", "cortex-memory"],
	["memory/knowledge", "cortex-memory"],
	["memory/memories", "cortex-memory"],
	["ontology", "cortex-memory"],
	["ontology/cortex", "cortex-memory"],
	["cortex", "cortex-memory"],
	["cortex/memory", "cortex-memory"],
	["cortex/apps", "cortex-memory"],
	["cortex-apps", "cortex-memory"],
	["matt", "cortex-memory"],
	["matt/memory", "cortex-memory"],
	["matt/apps", "cortex-memory"],
	["memory", "cortex-memory"],
	["embeddings", "cortex-memory"],
	["knowledge", "cortex-memory"],
	["audit/logs", "audit/logs"],
	["engine/logs", "audit/logs"],
	["audit/troubleshooter", "audit"],
	["cortex/troubleshooter", "audit"],
	["matt/troubleshooter", "audit"],
	["logs", "audit/logs"],
	["pipeline", "settings"],
	["predictor", "settings"],
	["connectors", "settings"],
	["engine/pipeline", "settings"],
	["engine/predictor", "settings"],
	["engine/connectors", "settings"],
	["cortex/tasks", "tasks"],
	["matt/tasks", "tasks"],
	["cortex-tasks", "tasks"],
]);

function readHash(): string {
	if (typeof window === "undefined") return "";
	return window.location.hash.slice(1);
}

function readTabFromHash(hash = readHash()): TabId | null {
	if (VALID_TABS.has(hash)) return hash as TabId;
	return HASH_ALIASES.get(hash) ?? null;
}

function canonicalHash(hash: string, tab: TabId): string {
	const exact = HASH_CANONICAL.get(hash);
	if (exact) return exact;
	if (hash === tab) return hash;
	return tab;
}

export const nav = $state({
	activeTab: "home" as TabId,
});

/* ── Tab groups (display-layer only) ── */

const MEMORY_TABS: ReadonlySet<TabId> = new Set(["cortex-memory"]);
const ENGINE_TABS: ReadonlySet<TabId> = new Set(["settings"]);
const CORTEX_TABS: ReadonlySet<TabId> = new Set(["cortex-memory"]);

export type NavGroup = "memory" | "engine" | "cortex";

const lastMemoryTab = $state({ value: "cortex-memory" as TabId });
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
	const next = VALID_TABS.has(tab) ? tab : (HASH_ALIASES.get(tab) ?? null);
	if (!next) return false;
	if (next === nav.activeTab) return true;
	if (!confirmDiscardChanges(`switch to ${next}`)) return false;
	nav.activeTab = next;
	if (MEMORY_TABS.has(next)) lastMemoryTab.value = next;
	if (ENGINE_TABS.has(next)) lastEngineTab.value = next;
	if (CORTEX_TABS.has(next)) lastCortexTab.value = next;
	if (typeof window !== "undefined") {
		history.replaceState(null, "", `#${next}`);
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
	const raw = readHash();
	const initial = readTabFromHash(raw);
	if (initial) {
		nav.activeTab = initial;
		if (typeof window !== "undefined") {
			const next = canonicalHash(raw, initial);
			if (raw !== next) {
				history.replaceState(null, "", `#${next}`);
			}
		}
	} else if (typeof window !== "undefined") {
		// No hash present — set it to the default tab
		history.replaceState(null, "", `#${nav.activeTab}`);
	}

	const onHashChange = () => {
		const next = readHash();
		const tab = readTabFromHash(next);
		if (!tab) return;
		if (tab !== nav.activeTab) nav.activeTab = tab;
		const target = canonicalHash(next, tab);
		if (next !== target) {
			history.replaceState(null, "", `#${target}`);
		}
	};
	window.addEventListener("hashchange", onHashChange);
	return () => window.removeEventListener("hashchange", onHashChange);
}
