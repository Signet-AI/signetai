/**
 * Workspace layout persistence store.
 * Persists panel widths, open sections, and density mode to localStorage.
 */

import { browser } from "$app/environment";

export interface WorkspaceLayout {
	pipeline: {
		feedExpanded: boolean;
		autoScroll: boolean;
	};
	embeddings: {
		controlsOpen: boolean;
		presetsOpen: boolean;
		sourcesOpen: boolean;
	};
	settings: {
		[key: string]: boolean;
	};
	density: "compact" | "default" | "comfortable";
}

const STORAGE_KEY = "signet-workspace-layout";

const defaultLayout: WorkspaceLayout = {
	pipeline: {
		feedExpanded: false,
		autoScroll: true,
	},
	embeddings: {
		controlsOpen: true,
		presetsOpen: false,
		sourcesOpen: true,
	},
	settings: {},
	density: "default",
};

function mergeLayoutWithDefaults(
	defaults: WorkspaceLayout,
	partial: Partial<WorkspaceLayout>,
): WorkspaceLayout {
	return {
		pipeline: { ...defaults.pipeline, ...partial.pipeline },
		embeddings: { ...defaults.embeddings, ...partial.embeddings },
		settings: { ...defaults.settings, ...partial.settings },
		density: partial.density ?? defaults.density,
	};
}

function loadLayout(): WorkspaceLayout {
	if (!browser) return defaultLayout;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return defaultLayout;
		const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>;
		return mergeLayoutWithDefaults(defaultLayout, parsed);
	} catch {
		return defaultLayout;
	}
}

function saveLayout(layout: WorkspaceLayout): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
	} catch {
		// ignore storage errors
	}
}

export const workspaceLayout = $state<WorkspaceLayout>(loadLayout());

export function syncLayoutToStorage(): void {
	saveLayout(workspaceLayout);
}

export function resetLayout(): void {
	Object.assign(workspaceLayout, defaultLayout);
	saveLayout(workspaceLayout);
}
