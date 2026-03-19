/** Signet OS store — app tray, widget grid, and sidebar group state. */

import { browser } from "$app/environment";
import { API_BASE } from "$lib/api";

// Types (mirrored from @signet/core signet-os-types — kept local to avoid
// build-time cross-package import issues in the dashboard)

export type AppTrayState = "tray" | "grid" | "dock";

export interface GridPosition {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface AutoCardToolAction {
	readonly name: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: unknown;
}

export interface AutoCardResource {
	readonly uri: string;
	readonly name: string;
	readonly description?: string;
	readonly mimeType?: string;
}

export interface AutoCardManifest {
	readonly name: string;
	readonly icon?: string;
	readonly tools: readonly AutoCardToolAction[];
	readonly resources: readonly AutoCardResource[];
	readonly hasAppResources: boolean;
	readonly defaultSize: { w: number; h: number };
}

export interface SignetAppManifest {
	readonly name: string;
	readonly icon?: string;
	readonly ui?: string;
	readonly defaultSize?: { w: number; h: number };
	readonly events?: { subscribe?: readonly string[]; emit?: readonly string[] };
	readonly menuItems?: readonly string[];
	readonly dock?: boolean;
}

export interface AppTrayEntry {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly state: AppTrayState;
	readonly manifest: SignetAppManifest;
	readonly autoCard: AutoCardManifest;
	readonly hasDeclaredManifest: boolean;
	readonly gridPosition?: GridPosition;
	readonly createdAt: string;
	readonly updatedAt: string;
}

// Sidebar groups (persisted to localStorage)

export interface SidebarGroup {
	readonly id: string;
	readonly name: string;
	readonly items: string[]; // App IDs
}

// Reactive store

export const os = $state({
	/** All app tray entries from the daemon */
	entries: [] as AppTrayEntry[],
	/** Loading state */
	loading: false,
	/** Error from last fetch */
	error: null as string | null,
	/** Sidebar groups */
	groups: [] as SidebarGroup[],
	/** Currently active group filter (null = show all) */
	activeGroup: null as string | null,
	/** Currently dragging app ID */
	draggingId: null as string | null,
});

/** Apps currently in the bottom tray */
export function getTrayApps(): AppTrayEntry[] {
	return os.entries.filter((e) => e.state === "tray");
}

/** Apps placed on the grid */
export function getGridApps(): AppTrayEntry[] {
	const apps = os.entries.filter((e) => e.state === "grid");
	if (os.activeGroup) {
		const group = os.groups.find((g) => g.id === os.activeGroup);
		if (group) {
			return apps.filter((a) => group.items.includes(a.id));
		}
	}
	return apps;
}

/** Apps pinned to the dock */
export function getDockApps(): AppTrayEntry[] {
	return os.entries.filter((e) => e.state === "dock");
}

const GRID_COLS = 12;

function findFreePosition(
	occupied: readonly GridPosition[],
	size: { w: number; h: number },
): GridPosition {
	for (let y = 0; y < 50; y++) {
		for (let x = 0; x <= GRID_COLS - size.w; x++) {
			const candidate = { x, y, w: size.w, h: size.h };
			const hit = occupied.some(
				(o) => x < o.x + o.w && x + size.w > o.x && y < o.y + o.h && y + size.h > o.y,
			);
			if (!hit) return candidate;
		}
	}
	const bottom = occupied.reduce((max, o) => Math.max(max, o.y + o.h), 0);
	return { x: 0, y: bottom, w: size.w, h: size.h };
}

export async function fetchTrayEntries(): Promise<void> {
	os.loading = true;
	os.error = null;
	try {
		const response = await fetch(`${API_BASE}/api/os/tray`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = await response.json();
		os.entries = data.entries ?? [];
	} catch (err) {
		os.error = err instanceof Error ? err.message : String(err);
	} finally {
		os.loading = false;
	}
}

export async function updateAppState(
	id: string,
	state: AppTrayState,
	gridPosition?: GridPosition,
): Promise<boolean> {
	try {
		const body: Record<string, unknown> = { state };
		if (gridPosition) body.gridPosition = gridPosition;

		const response = await fetch(`${API_BASE}/api/os/tray/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) return false;

		const data = await response.json();
		if (data.success && data.entry) {
			const idx = os.entries.findIndex((e) => e.id === id);
			if (idx >= 0) {
				os.entries[idx] = data.entry;
			}
		}
		return true;
	} catch {
		return false;
	}
}

export async function updateGridPosition(
	id: string,
	gridPosition: GridPosition,
): Promise<boolean> {
	return updateAppState(id, "grid", gridPosition);
}

export async function moveToGrid(
	id: string,
	gridPosition?: GridPosition,
): Promise<boolean> {
	const entry = os.entries.find((e) => e.id === id);
	if (!entry) return false;

	if (gridPosition) return updateAppState(id, "grid", gridPosition);

	// No position given — find a free spot via simple scan
	const size = entry.manifest?.defaultSize ?? { w: 4, h: 3 };
	const occupied = os.entries.flatMap((e) =>
		e.id !== id && e.state === "grid" && e.gridPosition ? [e.gridPosition] : [],
	);

	const pos = findFreePosition(occupied, size);
	return updateAppState(id, "grid", pos);
}

export async function moveToDock(id: string): Promise<boolean> {
	return updateAppState(id, "dock");
}

export async function moveToTray(id: string): Promise<boolean> {
	return updateAppState(id, "tray");
}

// Sidebar group management (localStorage-persisted)

const GROUPS_KEY = "signet-os-sidebar-groups";

export function loadGroups(): void {
	if (!browser) return;
	try {
		const raw = localStorage.getItem(GROUPS_KEY);
		if (raw) {
			os.groups = JSON.parse(raw);
		}
	} catch {
		os.groups = [];
	}
}

function saveGroups(): void {
	if (!browser) return;
	localStorage.setItem(GROUPS_KEY, JSON.stringify(os.groups));
}

export function createGroup(name: string): SidebarGroup {
	const group: SidebarGroup = {
		id: `group_${Date.now()}`,
		name,
		items: [],
	};
	os.groups = [...os.groups, group];
	saveGroups();
	return group;
}

export function deleteGroup(id: string): void {
	os.groups = os.groups.filter((g) => g.id !== id);
	if (os.activeGroup === id) os.activeGroup = null;
	saveGroups();
}

export function renameGroup(id: string, name: string): void {
	os.groups = os.groups.map((g) =>
		g.id === id ? { ...g, name } : g,
	);
	saveGroups();
}

export function addToGroup(groupId: string, appId: string): void {
	os.groups = os.groups.map((g) => {
		if (g.id !== groupId) return g;
		if (g.items.includes(appId)) return g;
		return { ...g, items: [...g.items, appId] };
	});
	saveGroups();
}

export function removeFromGroup(groupId: string, appId: string): void {
	os.groups = os.groups.map((g) => {
		if (g.id !== groupId) return g;
		return { ...g, items: g.items.filter((i) => i !== appId) };
	});
	saveGroups();
}

export function setActiveGroup(groupId: string | null): void {
	os.activeGroup = groupId;
}
