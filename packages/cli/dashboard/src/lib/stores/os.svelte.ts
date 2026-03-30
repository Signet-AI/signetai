/** Signet OS store — app tray, widget grid, and sidebar group state. */

import { browser } from "$app/environment";
import { API_BASE } from "$lib/api";

// Types (mirrored from @signet/core signet-os-types — kept local to avoid
// build-time cross-package import issues in the dashboard)

export type AppTrayState = "tray" | "grid" | "dock";

export const WIDGET_SIZES = {
	small: { w: 3, h: 2 },
	medium: { w: 4, h: 3 },
	large: { w: 6, h: 4 },
} as const;

export type WidgetSizePreset = keyof typeof WIDGET_SIZES;

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
	readonly html?: string;
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
	/** Currently expanded/focused widget ID */
	focusedId: null as string | null,
	/** Incremented when widgetHtmlCache or widgetGenerating changes, to trigger re-renders */
	widgetCacheVersion: 0,
});

/** In-memory cache of fetched widget HTML */
export const widgetHtmlCache = new Map<string, string>();

/** Set of server IDs currently being generated */
export const widgetGenerating = new Set<string>();

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

/**
 * Find a free grid position for a widget of the given size.
 *
 * Uses a ring-spiral scan outward from a desired origin (defaults to 0,0)
 * so that widgets cluster near the top-left rather than filling row-by-row.
 * Falls back to placing below all existing widgets if no gap is found
 * within 20 rings.
 */
export function findFreeGridPosition(
	occupied: readonly GridPosition[],
	size: { w: number; h: number },
	desired?: { x: number; y: number },
): GridPosition {
	const originX = desired?.x ?? 0;
	const originY = desired?.y ?? 0;

	function collides(x: number, y: number, w: number, h: number): boolean {
		for (const o of occupied) {
			if (x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y) {
				return true;
			}
		}
		return false;
	}

	// Check origin first
	const clampedX = Math.max(0, Math.min(GRID_COLS - size.w, originX));
	const clampedY = Math.max(0, originY);
	if (!collides(clampedX, clampedY, size.w, size.h)) {
		return { x: clampedX, y: clampedY, w: size.w, h: size.h };
	}

	// Spiral outward in expanding rings
	for (let radius = 1; radius <= 20; radius++) {
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
				const cx = Math.max(0, Math.min(GRID_COLS - size.w, originX + dx));
				const cy = Math.max(0, originY + dy);
				if (!collides(cx, cy, size.w, size.h)) {
					return { x: cx, y: cy, w: size.w, h: size.h };
				}
			}
		}
	}

	// Fallback: place below all existing widgets
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

export async function updateAppState(id: string, state: AppTrayState, gridPosition?: GridPosition): Promise<boolean> {
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

export async function updateGridPosition(id: string, gridPosition: GridPosition): Promise<boolean> {
	return updateAppState(id, "grid", gridPosition);
}

export async function moveToGrid(id: string, gridPosition?: GridPosition): Promise<boolean> {
	const entry = os.entries.find((e) => e.id === id);
	if (!entry) return false;

	if (gridPosition) return updateAppState(id, "grid", gridPosition);

	// No position given — find a free spot via simple scan
	const size = entry.manifest?.defaultSize ?? { w: 4, h: 3 };
	const occupied = os.entries.flatMap((e) =>
		e.id !== id && e.state === "grid" && e.gridPosition ? [e.gridPosition] : [],
	);

	const pos = findFreeGridPosition(occupied, size);
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
	os.groups = os.groups.map((g) => (g.id === id ? { ...g, name } : g));
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

// Widget focus & generation

// Widget actions — sent from chat to trigger widget behavior (refresh, navigate, highlight)
interface WidgetAction {
	action: string;
	data?: unknown;
	_seq: number;
}
const widgetActions = $state<Map<string, WidgetAction>>(new Map());
let actionSeq = 0;

export function sendWidgetAction(serverId: string, action: string, data?: unknown): void {
	widgetActions.set(serverId, { action, data, _seq: ++actionSeq });
	// Auto-clear after a short delay
	setTimeout(() => {
		const current = widgetActions.get(serverId);
		if (current && current._seq === actionSeq) {
			widgetActions.delete(serverId);
		}
	}, 500);
}

export function getWidgetAction(serverId: string): WidgetAction | undefined {
	return widgetActions.get(serverId);
}

export function expandWidget(id: string): void {
	os.focusedId = id;
}

export function collapseWidget(): void {
	os.focusedId = null;
}

export async function fetchWidgetHtml(serverId: string): Promise<string | null> {
	if (widgetHtmlCache.has(serverId)) return widgetHtmlCache.get(serverId) ?? null;
	try {
		const res = await fetch(`${API_BASE}/api/os/widget/${encodeURIComponent(serverId)}`);
		if (!res.ok) return null;
		const data = await res.json();
		if (data.html) {
			widgetHtmlCache.set(serverId, data.html);
			os.widgetCacheVersion++;
			return data.html;
		}
		return null;
	} catch {
		return null;
	}
}

export async function requestWidgetGen(serverId: string): Promise<void> {
	if (widgetGenerating.has(serverId)) return;
	widgetGenerating.add(serverId);
	os.widgetCacheVersion++;
	try {
		const res = await fetch(`${API_BASE}/api/os/widget/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ serverId, force: false }),
		});
		const data = await res.json();
		if (data.status === "cached" && data.html) {
			widgetHtmlCache.set(serverId, data.html);
		}
		// If status is "generating", we wait for SSE event
	} catch {
		// Generation failed silently — widget stays as AutoCard
	} finally {
		if (!widgetHtmlCache.has(serverId)) {
			// Still generating, keep in set
		} else {
			widgetGenerating.delete(serverId);
		}
		os.widgetCacheVersion++;
	}
}

export function onWidgetGenerated(serverId: string, html: string): void {
	widgetHtmlCache.set(serverId, html);
	widgetGenerating.delete(serverId);
	os.widgetCacheVersion++;
}

// ============================================================================
// Widget Sandbox Registry — allows AgentChat to find and control widget iframes
// ============================================================================

export interface WidgetSandboxRef {
	getDomState: () => Promise<unknown>;
	executeAction: (action: {
		type: string;
		index?: number;
		text?: string;
		direction?: string;
		amount?: number;
	}) => Promise<unknown>;
	agentStart: () => void;
	agentStop: () => void;
}

const widgetSandboxRegistry = new Map<string, WidgetSandboxRef>();

export function registerWidgetSandbox(serverId: string, ref: WidgetSandboxRef): void {
	widgetSandboxRegistry.set(serverId, ref);
}

export function unregisterWidgetSandbox(serverId: string): void {
	widgetSandboxRegistry.delete(serverId);
}

export function getWidgetSandbox(serverId: string): WidgetSandboxRef | undefined {
	return widgetSandboxRegistry.get(serverId);
}

// ============================================================================
// Agent Session State — tracks active page-agent automation sessions
// ============================================================================

export interface AgentSession {
	serverId: string;
	status: "starting" | "observing" | "thinking" | "acting" | "done" | "error";
	currentStep: number;
	totalSteps: number;
	lastAction?: string;
	error?: string;
}

export const agentSession = $state<{ current: AgentSession | null }>({ current: null });

export function setAgentSession(session: AgentSession | null): void {
	agentSession.current = session;
}

export function updateAgentStep(step: number, status: AgentSession["status"], lastAction?: string): void {
	if (agentSession.current) {
		agentSession.current.currentStep = step;
		agentSession.current.status = status;
		if (lastAction) agentSession.current.lastAction = lastAction;
	}
}
