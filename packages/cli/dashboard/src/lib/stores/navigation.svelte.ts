/**
 * Shared navigation state for the dashboard.
 */

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

export function setTab(tab: TabId): void {
	nav.activeTab = tab;
}

