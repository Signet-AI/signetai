/**
 * Focus management for keyboard navigation.
 *
 * Tracks which part of the UI has focus (sidebar vs page content)
 * and coordinates focus transitions for seamless keyboard navigation.
 */

import { nav, type TabId } from "./navigation.svelte";

export type FocusZone = "sidebar-menu" | "sidebar-footer" | "page-content";

export type SidebarFocusItem =
	| "home"
	| "cortex"
	| "secrets"
	| "skills"
	| "engine-group"
	| "theme-toggle"
	| "github-link";

/**
 * Sidebar navigation order for arrow key cycling
 */
export const SIDEBAR_ORDER: readonly SidebarFocusItem[] = [
	"home",
	"cortex",
	"secrets",
	"skills",
	"engine-group",
	"theme-toggle",
	"github-link",
] as const;

/**
 * Map active tab to corresponding sidebar item
 */
function tabToSidebarItem(tab: string): SidebarFocusItem {
	switch (tab) {
		case "settings":
		case "pipeline":
		case "connectors":
		case "logs":
		case "predictor":
			return "engine-group";
		case "memory":
		case "timeline":
		case "embeddings":
		case "knowledge":
		case "cortex-memory":
		case "cortex-apps":
		case "cortex-tasks":
		case "cortex-troubleshooter":
		case "os":
		case "tasks":
			return "cortex";
		case "home":
		case "secrets":
		case "skills":
			return tab;
		default:
			return "home";
	}
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
	switch (item) {
		case "cortex":
			return "cortex-memory";
		case "engine-group":
			return "settings";
		case "theme-toggle":
		case "github-link":
			return null;
		case "home":
		case "secrets":
		case "skills":
			return item;
	}
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
		// Try to scope to the active tab panel first, fall back to page content
		const activePanel = document.querySelector('[data-tab-panel-active="true"]');
		const pageContent = activePanel ?? document.querySelector('[data-page-content="true"]');
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
