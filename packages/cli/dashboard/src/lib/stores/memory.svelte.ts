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
