/**
 * Shared skills state for SkillsTab and sub-components.
 * Follows the same $state pattern as memory.svelte.ts.
 */

import {
	type Skill,
	type SkillDetail,
	type SkillSearchResult,
	browseSkills,
	getSkill,
	getSkills,
	installSkill,
	searchSkills,
	uninstallSkill,
} from "$lib/api";
import { shouldPreserveCatalogOnEmptyRefresh } from "$lib/stores/skills-load-policy";
import { toast } from "$lib/stores/toast.svelte";

export type SkillsView = "browse" | "installed";
export type SortBy = "popularity" | "installs" | "stars" | "name" | "newest";
export type ProviderFilter = "all" | "signet" | "skills.sh" | "clawhub";
export type CategoryFilter = "all" | string;

// Cache the browse catalog in localStorage so the grid renders instantly on
// repeat loads. Background-refresh if the entry is older than CATALOG_CACHE_TTL.
const CATALOG_CACHE_KEY = "signet:skills:catalog:v1";
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

type CatalogCache = {
	ts: number;
	results: SkillSearchResult[];
	total: number;
};

function loadCatalogCache(): CatalogCache | null {
	try {
		const raw = localStorage.getItem(CATALOG_CACHE_KEY);
		if (!raw) return null;
		const cache = JSON.parse(raw) as CatalogCache;
		if (typeof cache.ts !== "number" || !Array.isArray(cache.results) || typeof cache.total !== "number") {
			return null;
		}
		return cache;
	} catch {
		return null;
	}
}

function saveCatalogCache(results: SkillSearchResult[], total: number): void {
	try {
		const entry: CatalogCache = { ts: Date.now(), results, total };
		localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(entry));
	} catch {
		// localStorage unavailable (private browsing, storage quota, etc.)
	}
}

async function refreshCatalogInBackground(): Promise<void> {
	try {
		const data = await browseSkills();
		sk.catalog = data.results;
		sk.catalogTotal = data.total;
		saveCatalogCache(data.results, data.total);
	} catch {
		// Background refresh failing silently is acceptable — cache still served
	}
}

export const sk = $state({
	view: "installed" as SkillsView,

	installed: [] as Skill[],
	loading: false,

	// Browse catalog
	catalog: [] as SkillSearchResult[],
	catalogTotal: 0,
	catalogLoading: false,
	catalogLoaded: false,

	// Search
	query: "",
	results: [] as SkillSearchResult[],
	searching: false,

	// Sort & filter
	sortBy: "popularity" as SortBy,
	providerFilter: "all" as ProviderFilter,
	categoryFilter: "all" as CategoryFilter,

	// Compare mode
	compareSelected: [] as string[],

	// Detail panel
	selectedName: null as string | null,
	detailOpen: false,
	detailContent: "",
	detailMeta: null as Skill | null,
	detailLoading: false,
	detailSource: null as SkillSearchResult | null,

	// Actions
	installing: null as string | null,
	uninstalling: null as string | null,
});

/** Catalog indexed by name — shared across all SkillCard instances. */
const catalogByName = $derived(new Map(sk.catalog.map((c) => [c.name, c])));
export function getCatalogByName(): Map<string, SkillSearchResult> {
	return catalogByName;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let installedLoadPromise: Promise<void> | null = null;
let catalogLoadPromise: Promise<void> | null = null;

type InstalledLoadOptions = {
	force?: boolean;
};

type CatalogLoadOptions = {
	force?: boolean;
};

function sortItems(items: readonly SkillSearchResult[], sortBy: SortBy): SkillSearchResult[] {
	const sorted = [...items];
	switch (sortBy) {
		case "popularity":
			return sorted.sort(
				(a, b) => (b.popularityScore ?? b.installsRaw ?? 0) - (a.popularityScore ?? a.installsRaw ?? 0),
			);
		case "installs":
			return sorted.sort((a, b) => (b.installsRaw ?? 0) - (a.installsRaw ?? 0));
		case "stars":
			return sorted.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
		case "name":
			return sorted.sort((a, b) => a.name.localeCompare(b.name));
		case "newest":
			// Items without timestamps sort to the end
			return sorted;
		default:
			return sorted;
	}
}

function filterByProvider(items: readonly SkillSearchResult[], provider: ProviderFilter): SkillSearchResult[] {
	if (provider === "all") return [...items];
	return items.filter((s) => s.provider === provider);
}

function filterByCategory(items: readonly SkillSearchResult[], category: CategoryFilter): SkillSearchResult[] {
	if (category === "all") return [...items];
	return items.filter((s) => (s.category ?? "Other") === category);
}

export function getCategoryOptions(): string[] {
	const values = new Set<string>(["all"]);
	for (const item of [...sk.catalog, ...sk.results]) {
		values.add(item.category ?? "Other");
	}
	return Array.from(values);
}

export function getFilteredCatalog(): SkillSearchResult[] {
	const filteredByProvider = filterByProvider(sk.catalog, sk.providerFilter);
	const filtered = filterByCategory(filteredByProvider, sk.categoryFilter);
	return sortItems(filtered, sk.sortBy);
}

export function getFilteredResults(): SkillSearchResult[] {
	const filteredByProvider = filterByProvider(sk.results, sk.providerFilter);
	const filtered = filterByCategory(filteredByProvider, sk.categoryFilter);
	return sortItems(filtered, sk.sortBy);
}

export function resetFilters(): void {
	sk.sortBy = "popularity";
	sk.providerFilter = "all";
	sk.categoryFilter = "all";
}

export function clearCompare(): void {
	sk.compareSelected = [];
}

export function toggleCompare(skillKey: string): void {
	const has = sk.compareSelected.includes(skillKey);
	if (has) {
		sk.compareSelected = sk.compareSelected.filter((k) => k !== skillKey);
		return;
	}
	if (sk.compareSelected.length >= 3) return;
	sk.compareSelected = [...sk.compareSelected, skillKey];
}

export async function fetchInstalled(options: InstalledLoadOptions = {}): Promise<void> {
	if (installedLoadPromise) {
		if (!options.force) return installedLoadPromise;
		await installedLoadPromise;
	}

	installedLoadPromise = (async () => {
		sk.loading = true;
		try {
			sk.installed = await getSkills();
		} finally {
			sk.loading = false;
			installedLoadPromise = null;
		}
	})();

	return installedLoadPromise;
}

export async function fetchCatalog(options: CatalogLoadOptions = {}): Promise<void> {
	const force = options.force === true;
	if (!force && sk.catalogLoaded && sk.catalog.length > 0) return;
	if (catalogLoadPromise) return catalogLoadPromise;

	if (!force) {
		const cached = loadCatalogCache();
		if (cached) {
			// Serve cache immediately — grid renders with no loading state
			sk.catalog = cached.results;
			sk.catalogTotal = cached.total;
			sk.catalogLoaded = true;
			sk.catalogLoading = false;
			// Refresh in the background if the entry is stale
			if (Date.now() - cached.ts > CATALOG_CACHE_TTL) {
				void refreshCatalogInBackground();
			}
			return;
		}
	}

	// Cold load — no cache yet, show spinner and wait. Multiple callers share
	// one owner promise so an embedded SkillsTab cannot leave the shared loading
	// flag true after the marketplace parent already finished loading.
	catalogLoadPromise = (async () => {
		sk.catalogLoading = true;
		try {
			const data = await browseSkills();
			if (shouldPreserveCatalogOnEmptyRefresh(data.results.length, sk.catalog.length)) {
				sk.catalogLoaded = true;
				return;
			}
			sk.catalog = data.results;
			sk.catalogTotal = data.total;
			sk.catalogLoaded = true;
			saveCatalogCache(data.results, data.total);
		} finally {
			sk.catalogLoading = false;
			catalogLoadPromise = null;
		}
	})();

	return catalogLoadPromise;
}

export function setQuery(q: string): void {
	sk.query = q;
	if (searchTimer) clearTimeout(searchTimer);
	if (!q.trim()) {
		sk.results = [];
		sk.searching = false;
		return;
	}
	sk.searching = true;
	searchTimer = setTimeout(() => doSearch(), 250);
}

export async function doSearch(): Promise<void> {
	const q = sk.query.trim();
	if (!q) {
		sk.results = [];
		sk.searching = false;
		return;
	}
	sk.searching = true;
	sk.results = await searchSkills(q);
	sk.searching = false;
}

function findCatalogMatch(name: string, source?: string): SkillSearchResult | undefined {
	const matches = [...sk.results, ...sk.catalog].filter((s) => s.name === name);
	if (source) return matches.find((s) => s.fullName === source) ?? matches[0];
	return matches[0];
}

export async function openDetail(name: string, source?: string): Promise<void> {
	sk.selectedName = name;
	sk.detailOpen = true;
	sk.detailLoading = true;
	sk.detailContent = "";
	sk.detailMeta = null;

	// Find source from search results or catalog for remote fetch
	const match = findCatalogMatch(name, source);
	sk.detailSource = match ?? null;
	const detailSource = source ?? match?.fullName;

	const detail = await getSkill(name, detailSource);
	if (detail) {
		sk.detailMeta = detail;
		sk.detailContent = (detail as SkillDetail).content ?? "";
	}
	sk.detailLoading = false;
}

export function closeDetail(): void {
	sk.detailOpen = false;
	sk.selectedName = null;
	sk.detailContent = "";
	sk.detailMeta = null;
	sk.detailSource = null;
}

export async function doInstall(name: string, source?: string): Promise<void> {
	sk.installing = name;
	// Look up fullName from search results, the active detail pane, or catalog.
	const detailSource = sk.detailOpen && sk.selectedName === name ? sk.detailSource?.fullName : undefined;
	const requestedSource = source ?? detailSource;
	const match = findCatalogMatch(name, requestedSource);
	const installSource = requestedSource ?? match?.fullName;
	const result = await installSkill(name, installSource);
	if (result.success) {
		toast(`Skill ${name} installed`, "success");
		await fetchInstalled({ force: true });
		// Update installed flag in results and catalog
		const markInstalled = (s: SkillSearchResult) => (s.name === name ? { ...s, installed: true } : s);
		sk.results = sk.results.map(markInstalled);
		sk.catalog = sk.catalog.map(markInstalled);
	} else {
		toast(`Failed to install ${name}`, "error");
	}
	sk.installing = null;
}

export async function doUninstall(name: string): Promise<void> {
	sk.uninstalling = name;
	const result = await uninstallSkill(name);
	if (result.success) {
		toast(`Skill ${name} uninstalled`, "success");
		await fetchInstalled({ force: true });
		const markUninstalled = (s: SkillSearchResult) => (s.name === name ? { ...s, installed: false } : s);
		sk.results = sk.results.map(markUninstalled);
		sk.catalog = sk.catalog.map(markUninstalled);
		if (sk.selectedName === name) closeDetail();
	} else {
		toast(`Failed to uninstall ${name}`, "error");
	}
	sk.uninstalling = null;
}
