/**
 * Shared navigation state for the dashboard.
 */

import { confirmDiscardChanges } from "$lib/stores/unsaved-changes.svelte";

export type TabId =
	| "config"
	| "settings"
	| "memory"
	| "embeddings"
	| "pipeline"
	| "logs"
	| "secrets"
	| "skills"
	| "tasks";

export const nav = $state({
	activeTab: "config" as TabId,
});

export function setTab(tab: TabId): boolean {
	if (tab === nav.activeTab) return true;
	if (!confirmDiscardChanges(`switch to ${tab}`)) return false;
	nav.activeTab = tab;
	return true;
}
