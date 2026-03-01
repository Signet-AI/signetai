/**
 * Shared memory state for MemoryTab and RightMemoryPanel.
 * Uses a single $state object so consumers can mutate properties
 * without hitting Svelte 5's "Cannot assign to import" restriction.
 */

import {
	searchMemories,
	recallMemories,
	getSimilarMemories,
	getDistinctWho,
	updateMemory,
	deleteMemory,
	type Memory,
} from "$lib/api";

export const mem = $state({
	query: "",
	results: [] as Memory[],
	searched: false,
	searching: false,

	filtersOpen: false,
	filterType: "",
	filterTags: "",
	filterWho: "",
	filterPinned: false,
	filterImportanceMin: "",
	filterSince: "",
	whoOptions: [] as string[],

	similarSourceId: null as string | null,
	similarSource: null as Memory | null,
	similarResults: [] as Memory[],
	loadingSimilar: false,

	// Edit / delete form state
	editingId: null as string | null,
	editMode: null as "edit" | "delete" | null,
	formOpen: false,

	// Track locally-deleted IDs so the default (prop) view hides them
	deletedIds: new Set<string>(),
});

export function hasActiveFilters(): boolean {
	return !!(
		mem.filterType ||
		mem.filterTags ||
		mem.filterWho ||
		mem.filterPinned ||
		mem.filterImportanceMin ||
		mem.filterSince
	);
}

// --- Timer ---
let searchTimer: ReturnType<typeof setTimeout> | null = null;

export function clearSearchTimer(): void {
	if (searchTimer) {
		clearTimeout(searchTimer);
		searchTimer = null;
	}
}

// --- Actions ---

export function queueMemorySearch(): void {
	if (searchTimer) clearTimeout(searchTimer);
	searchTimer = setTimeout(() => doSearch(), 150);
}

export async function doSearch(): Promise<void> {
	clearSearchTimer();

	const query = mem.query.trim();
	if (!query && !hasActiveFilters()) {
		mem.results = [];
		mem.searched = false;
		mem.similarSourceId = null;
		mem.similarSource = null;
		mem.similarResults = [];
		return;
	}

	mem.similarSourceId = null;
	mem.similarSource = null;
	mem.similarResults = [];
	mem.searching = true;

	const parsedImportance = mem.filterImportanceMin
		? parseFloat(mem.filterImportanceMin)
		: undefined;

	const filters = {
		type: mem.filterType || undefined,
		tags: mem.filterTags || undefined,
		who: mem.filterWho || undefined,
		pinned: mem.filterPinned || undefined,
		importance_min: parsedImportance,
		since: mem.filterSince || undefined,
	};

	try {
		if (query) {
			mem.results = await recallMemories(query, { ...filters, limit: 120 });
		} else {
			mem.results = await searchMemories("", { ...filters, limit: 250 });
		}
		mem.searched = true;
	} finally {
		mem.searching = false;
	}
}

export async function findSimilar(
	id: string,
	sourceMemory: Memory,
): Promise<void> {
	mem.similarSourceId = id;
	mem.similarSource = sourceMemory;
	mem.loadingSimilar = true;
	mem.similarResults = [];
	try {
		mem.similarResults = await getSimilarMemories(
			id,
			10,
			mem.filterType || undefined,
		);
	} finally {
		mem.loadingSimilar = false;
	}
}

export function clearAll(): void {
	mem.query = "";
	mem.results = [];
	mem.searched = false;
	mem.filterType = "";
	mem.filterTags = "";
	mem.filterWho = "";
	mem.filterPinned = false;
	mem.filterImportanceMin = "";
	mem.filterSince = "";
	mem.similarSourceId = null;
	mem.similarSource = null;
	mem.similarResults = [];
	clearSearchTimer();
}

export function loadWhoOptions(): void {
	getDistinctWho()
		.then((values) => {
			mem.whoOptions = values;
		})
		.catch(() => {});
}

// --- Edit / Delete ---

export function openEditForm(id: string, mode: "edit" | "delete"): void {
	mem.editingId = id;
	mem.editMode = mode;
	mem.formOpen = true;
}

export function closeEditForm(): void {
	mem.editingId = null;
	mem.editMode = null;
	mem.formOpen = false;
}

export async function doUpdateMemory(
	id: string,
	updates: {
		content?: string;
		type?: string;
		importance?: number;
		tags?: string;
		pinned?: boolean;
	},
	reason: string,
): Promise<{ success: boolean; error?: string }> {
	const result = await updateMemory(id, updates, reason);
	if (result.success) {
		// Refresh current view from server
		await doSearch();
	}
	return result;
}

export async function doDeleteMemory(
	id: string,
	reason: string,
	force = false,
): Promise<{ success: boolean; error?: string }> {
	const result = await deleteMemory(id, reason, force);
	if (result.success) {
		// If we deleted the similarity source, clear that panel
		if (id === mem.similarSourceId) {
			mem.similarSourceId = null;
			mem.similarSource = null;
			mem.similarResults = [];
		}
		// Remove from local results and track deletion
		mem.results = mem.results.filter((m) => m.id !== id);
		mem.similarResults = mem.similarResults.filter((m) => m.id !== id);
		mem.deletedIds.add(id);

		// Only re-fetch if there's an active search/filter
		if (mem.query.trim() || hasActiveFilters()) {
			await doSearch();
		}
	}
	return result;
}
