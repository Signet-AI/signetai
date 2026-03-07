/**
 * Focus management for keyboard navigation.
 *
 * Tracks which part of the UI has focus (sidebar vs page content)
 * and coordinates focus transitions for seamless keyboard navigation.
 */

import { nav, type TabId } from "./navigation.svelte";

export type FocusZone = "sidebar-menu" | "sidebar-footer" | "page-content";

export type SidebarFocusItem =
	| "config"
	| "memory-group"
	| "secrets"
	| "skills"
	| "tasks"
	| "engine-group"
	| "theme-toggle"
	| "github-link";

/**
 * Sidebar navigation order for arrow key cycling
 */
export const SIDEBAR_ORDER: readonly SidebarFocusItem[] = [
	"config",
	"memory-group",
	"secrets",
	"skills",
	"tasks",
	"engine-group",
	"theme-toggle",
	"github-link",
] as const;

/**
 * Map active tab to corresponding sidebar item
 */
function tabToSidebarItem(tab: string): SidebarFocusItem {
	if (tab === "settings" || tab === "pipeline" || tab === "connectors" || tab === "logs") {
		return "engine-group";
	}
	if (tab === "memory" || tab === "timeline" || tab === "embeddings") {
		return "memory-group";
	}
	return tab as SidebarFocusItem;
}

/**
 * Global focus state
 */
export const focus = $state({
	zone: "page-content" as FocusZone,
	sidebarItem: null as SidebarFocusItem | null,
});

/**
 * Set the current focus zone
 */
export function setFocusZone(zone: FocusZone): void {
	focus.zone = zone;
}

/**
 * Map sidebar item to corresponding tab for preview
 */
function sidebarItemToTab(item: SidebarFocusItem): TabId | null {
	if (item === "memory-group") return "memory";
	if (item === "engine-group") return "settings";
	if (item === "theme-toggle" || item === "github-link") return null;
	return item as TabId;
}

/**
 * Set the focused sidebar item
 */
export function setSidebarItem(item: SidebarFocusItem): void {
	focus.sidebarItem = item;

	// Auto-preview the tab when navigating in sidebar (but don't enter it)
	if (focus.zone === "sidebar-menu") {
		const tabToPreview = sidebarItemToTab(item);
		if (tabToPreview && tabToPreview !== nav.activeTab) {
			nav.activeTab = tabToPreview;
		}
	}

	// Focus the DOM element
	const element = document.querySelector(`[data-sidebar-item="${item}"]`);
	if (element instanceof HTMLElement) {
		element.focus({ preventScroll: false });
		element.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}
}

/**
 * Return focus to sidebar menu, selecting the item corresponding to current tab
 */
export function returnToSidebar(): void {
	focus.zone = "sidebar-menu";
	const item = tabToSidebarItem(nav.activeTab);
	setSidebarItem(item);
}

/**
 * Focus the first focusable element in the current page content
 */
export function focusFirstPageElement(): void {
	focus.zone = "page-content";

	// Use setTimeout to ensure DOM is ready after navigation
	setTimeout(() => {
		// Try to find the first focusable element in the page content
		const pageContent = document.querySelector('[data-page-content="true"]');
		if (!pageContent) return;

		const focusableSelectors = [
			'button:not([disabled])',
			'input:not([disabled])',
			'select:not([disabled])',
			'textarea:not([disabled])',
			'[tabindex="0"]',
			'a[href]',
		].join(", ");

		const firstFocusable = pageContent.querySelector(focusableSelectors);
		if (firstFocusable instanceof HTMLElement) {
			firstFocusable.focus({ preventScroll: false });
			firstFocusable.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, 50);
}

/**
 * Navigate to next sidebar item
 */
export function navigateSidebarNext(): void {
	const currentIndex = focus.sidebarItem
		? SIDEBAR_ORDER.indexOf(focus.sidebarItem)
		: -1;
	const nextIndex = (currentIndex + 1) % SIDEBAR_ORDER.length;
	setSidebarItem(SIDEBAR_ORDER[nextIndex]);
}

/**
 * Navigate to previous sidebar item
 */
export function navigateSidebarPrev(): void {
	const currentIndex = focus.sidebarItem
		? SIDEBAR_ORDER.indexOf(focus.sidebarItem)
		: 0;
	const prevIndex = currentIndex <= 0 ? SIDEBAR_ORDER.length - 1 : currentIndex - 1;
	setSidebarItem(SIDEBAR_ORDER[prevIndex]);
}
