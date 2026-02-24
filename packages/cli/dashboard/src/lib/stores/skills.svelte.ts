/**
 * Shared skills state for SkillsTab and sub-components.
 * Follows the same $state pattern as memory.svelte.ts.
 */

import {
	getSkills,
	getSkill,
	searchSkills,
	browseSkills,
	installSkill,
	uninstallSkill,
	type Skill,
	type SkillSearchResult,
	type SkillDetail,
} from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

export type SkillsView = "browse" | "installed";
export type SortBy = "installs" | "stars" | "name" | "newest";
export type ProviderFilter = "all" | "skills.sh" | "clawhub";

export const sk = $state({
	view: "browse" as SkillsView,

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
	sortBy: "installs" as SortBy,
	providerFilter: "all" as ProviderFilter,

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

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function sortItems(items: readonly SkillSearchResult[], sortBy: SortBy): SkillSearchResult[] {
	const sorted = [...items];
	switch (sortBy) {
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

function filterByProvider(
	items: readonly SkillSearchResult[],
	provider: ProviderFilter,
): SkillSearchResult[] {
	if (provider === "all") return [...items];
	return items.filter((s) => s.provider === provider);
}

export function getFilteredCatalog(): SkillSearchResult[] {
	const filtered = filterByProvider(sk.catalog, sk.providerFilter);
	return sortItems(filtered, sk.sortBy);
}

export function getFilteredResults(): SkillSearchResult[] {
	const filtered = filterByProvider(sk.results, sk.providerFilter);
	return sortItems(filtered, sk.sortBy);
}

export async function fetchInstalled(): Promise<void> {
	sk.loading = true;
	sk.installed = await getSkills();
	sk.loading = false;
}

export async function fetchCatalog(): Promise<void> {
	if (sk.catalogLoaded) return;
	sk.catalogLoading = true;
	const data = await browseSkills();
	sk.catalog = data.results;
	sk.catalogTotal = data.total;
	sk.catalogLoaded = true;
	sk.catalogLoading = false;
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

export async function openDetail(name: string): Promise<void> {
	sk.selectedName = name;
	sk.detailOpen = true;
	sk.detailLoading = true;
	sk.detailContent = "";
	sk.detailMeta = null;

	// Find source from search results or catalog for remote fetch
	const match =
		sk.results.find((s) => s.name === name) ||
		sk.catalog.find((s) => s.name === name);
	sk.detailSource = match ?? null;
	const source = match?.fullName || undefined;

	const detail = await getSkill(name, source);
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

export async function doInstall(name: string): Promise<void> {
	sk.installing = name;
	// Look up fullName from search results or catalog
	const match =
		sk.results.find((s) => s.name === name) ||
		sk.catalog.find((s) => s.name === name);
	const source = match?.fullName || undefined;
	const result = await installSkill(name, source);
	if (result.success) {
		toast(`Skill ${name} installed`, "success");
		await fetchInstalled();
		// Update installed flag in results and catalog
		const markInstalled = (s: SkillSearchResult) =>
			s.name === name ? { ...s, installed: true } : s;
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
		await fetchInstalled();
		const markUninstalled = (s: SkillSearchResult) =>
			s.name === name ? { ...s, installed: false } : s;
		sk.results = sk.results.map(markUninstalled);
		sk.catalog = sk.catalog.map(markUninstalled);
		if (sk.selectedName === name) closeDetail();
	} else {
		toast(`Failed to uninstall ${name}`, "error");
	}
	sk.uninstalling = null;
}
