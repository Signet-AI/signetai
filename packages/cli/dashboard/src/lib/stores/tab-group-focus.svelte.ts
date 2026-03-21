/**
 * Keyboard navigation state and handlers for tab group focus management.
 *
 * Extracted from +page.svelte to keep the page shell thin.
 * All state here is module-level (singleton) since there's one page.
 */

import {
	nav,
	isEngineGroup,
	isMemoryGroup,
	isCortexGroup,
	setTab,
} from "$lib/stores/navigation.svelte";
import {
	focus,
	returnToSidebar,
	setFocusZone,
	focusFirstPageElement,
	SIDEBAR_ORDER,
	type SidebarFocusItem,
} from "$lib/stores/focus.svelte";
import { ts } from "$lib/stores/tasks.svelte";
import { mem } from "$lib/stores/memory.svelte";

// --- Type-safe helpers (avoids `as` casts on readonly tuples) ---

function includesString<T extends readonly string[]>(arr: T, value: string): value is T[number] {
	return arr.includes(value as T[number]);
}

export function indexOfString(arr: readonly string[], value: string): number {
	return arr.indexOf(value);
}

function isSidebarItem(value: string): value is SidebarFocusItem {
	return includesString(SIDEBAR_ORDER, value);
}

// --- Tab group arrays (ordered for arrow-key cycling) ---

export const ENGINE_TABS = ["settings", "pipeline", "predictor", "connectors", "logs"] as const;
export const MEMORY_TABS = ["memory", "timeline", "knowledge", "embeddings"] as const;
export const CORTEX_TABS = ["cortex-memory", "cortex-apps", "cortex-tasks", "cortex-troubleshooter"] as const;

// --- State ---

export const tabFocus = $state({
	keyboardNavActive: false,
	engineFocus: "tabs" as "tabs" | "content",
	engineIndex: 0,
	memoryFocus: "tabs" as "tabs" | "content",
	memoryIndex: 0,
	cortexFocus: "tabs" as "tabs" | "content",
	cortexIndex: 0,
});

// --- Focus functions ---

export function focusEngineTab(index: number): void {
	tabFocus.engineIndex = index;
	tabFocus.engineFocus = "tabs";
	setTab(ENGINE_TABS[index]);

	const tabButton = document.querySelector(`[data-engine-tab="${ENGINE_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

export function focusEngineContent(): void {
	tabFocus.engineFocus = "content";
	focusFirstPageElement();
}

export function focusMemoryTab(index: number): void {
	tabFocus.memoryIndex = index;
	tabFocus.memoryFocus = "tabs";
	setTab(MEMORY_TABS[index]);

	const tabButton = document.querySelector(`[data-memory-tab="${MEMORY_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

export function focusMemoryContent(): void {
	tabFocus.memoryFocus = "content";
	focusFirstPageElement();
}

export function focusCortexTab(index: number): void {
	tabFocus.cortexIndex = index;
	tabFocus.cortexFocus = "tabs";
	setTab(CORTEX_TABS[index]);

	const tabButton = document.querySelector(`[data-cortex-tab="${CORTEX_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

export function focusCortexContent(): void {
	tabFocus.cortexFocus = "content";
	focusFirstPageElement();
}

// --- Window event handlers ---

export function handleGlobalKey(e: KeyboardEvent): void {
	const activeTab = nav.activeTab;
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;

	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	// Don't interfere with any focused input, regardless of zone
	if (isInputFocused) return;

	if (focus.zone === "page-content" &&
		((isEngineGroup(activeTab) && tabFocus.engineFocus === "content") ||
		 (isMemoryGroup(activeTab) && tabFocus.memoryFocus === "content") ||
		 (isCortexGroup(activeTab) && tabFocus.cortexFocus === "content"))) {
		// Already in content mode -- keep keyboardNavActive as-is
	} else {
		tabFocus.keyboardNavActive = true;
	}

	// Sync index from activeTab to prevent stale-index navigation
	if (isEngineGroup(activeTab)) {
		const liveIndex = indexOfString(ENGINE_TABS, activeTab);
		if (liveIndex !== -1) tabFocus.engineIndex = liveIndex;
	} else if (isMemoryGroup(activeTab)) {
		const liveIndex = indexOfString(MEMORY_TABS, activeTab);
		if (liveIndex !== -1) tabFocus.memoryIndex = liveIndex;
	} else if (isCortexGroup(activeTab)) {
		const liveIndex = indexOfString(CORTEX_TABS, activeTab);
		if (liveIndex !== -1) tabFocus.cortexIndex = liveIndex;
	}

	// Escape from page content
	if (focus.zone === "page-content" && e.key === "Escape") {
		if (e.defaultPrevented) return;

		const modalOpen =
			ts.formOpen ||
			ts.detailOpen ||
			mem.formOpen ||
			document.querySelector('[role="dialog"][data-state="open"]');

		if (!modalOpen) {
			e.preventDefault();
			if (isEngineGroup(activeTab) && tabFocus.engineFocus === "content") {
				focusEngineTab(tabFocus.engineIndex);
			} else if (isMemoryGroup(activeTab) && tabFocus.memoryFocus === "content") {
				focusMemoryTab(tabFocus.memoryIndex);
			} else if (isCortexGroup(activeTab) && tabFocus.cortexFocus === "content") {
				focusCortexTab(tabFocus.cortexIndex);
			} else {
				returnToSidebar();
			}
		}
	}

	// Engine tab group navigation
	if (isEngineGroup(activeTab) && focus.zone === "page-content" && !e.defaultPrevented) {
		if (tabFocus.engineFocus === "tabs") {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (tabFocus.engineIndex === 0) {
					returnToSidebar();
				} else {
					focusEngineTab(tabFocus.engineIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusEngineTab((tabFocus.engineIndex + 1) % ENGINE_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusEngineContent();
			}
		} else if (tabFocus.engineFocus === "content") {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusEngineTab(tabFocus.engineIndex);
			}
		}
	}

	// Memory tab group navigation
	if (isMemoryGroup(activeTab) && focus.zone === "page-content" && !e.defaultPrevented) {
		if (tabFocus.memoryFocus === "tabs") {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (tabFocus.memoryIndex === 0) {
					returnToSidebar();
				} else {
					focusMemoryTab(tabFocus.memoryIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusMemoryTab((tabFocus.memoryIndex + 1) % MEMORY_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusMemoryContent();
			}
		} else if (tabFocus.memoryFocus === "content") {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusMemoryTab(tabFocus.memoryIndex);
			}
		}
	}

	// Cortex tab group navigation
	if (isCortexGroup(activeTab) && focus.zone === "page-content" && !e.defaultPrevented) {
		if (tabFocus.cortexFocus === "tabs") {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (tabFocus.cortexIndex === 0) {
					returnToSidebar();
				} else {
					focusCortexTab(tabFocus.cortexIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusCortexTab((tabFocus.cortexIndex + 1) % CORTEX_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusCortexContent();
			}
		} else if (tabFocus.cortexFocus === "content") {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusCortexTab(tabFocus.cortexIndex);
			}
		}
	}
}

export function handleFocusIn(e: FocusEvent): void {
	const activeTab = nav.activeTab;
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;

	const sidebarItem = target.closest('[data-sidebar-item]');
	if (sidebarItem) {
		const rawItem = sidebarItem.getAttribute('data-sidebar-item');
		if (rawItem && isSidebarItem(rawItem) && focus.sidebarItem !== rawItem) {
			focus.zone = 'sidebar-menu';
			focus.sidebarItem = rawItem;
		}
		return;
	}

	const engineTab = target.closest('[data-engine-tab]');
	if (engineTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const rawTabName = engineTab.getAttribute('data-engine-tab');
		if (rawTabName === null) return;
		const index = indexOfString(ENGINE_TABS, rawTabName);
		if (index !== -1) {
			tabFocus.engineIndex = index;
			tabFocus.engineFocus = "tabs";
		}
		return;
	}

	const memoryTab = target.closest('[data-memory-tab]');
	if (memoryTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const rawTabName = memoryTab.getAttribute('data-memory-tab');
		if (rawTabName === null) return;
		const index = indexOfString(MEMORY_TABS, rawTabName);
		if (index !== -1) {
			tabFocus.memoryIndex = index;
			tabFocus.memoryFocus = "tabs";
		}
		return;
	}

	const cortexTab = target.closest('[data-cortex-tab]');
	if (cortexTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const rawTabName = cortexTab.getAttribute('data-cortex-tab');
		if (rawTabName === null) return;
		const index = indexOfString(CORTEX_TABS, rawTabName);
		if (index !== -1) {
			tabFocus.cortexIndex = index;
			tabFocus.cortexFocus = "tabs";
		}
		return;
	}

	const pageContent = target.closest('[data-page-content="true"]');
	if (pageContent && focus.zone !== 'page-content') {
		setFocusZone('page-content');

		// Tab-button targets already returned above, so focus is in content area
		if (isEngineGroup(activeTab)) {
			const index = indexOfString(ENGINE_TABS, activeTab);
			if (index !== -1) {
				tabFocus.engineIndex = index;
				tabFocus.engineFocus = "content";
			}
		} else if (isMemoryGroup(activeTab)) {
			const index = indexOfString(MEMORY_TABS, activeTab);
			if (index !== -1) {
				tabFocus.memoryIndex = index;
				tabFocus.memoryFocus = "content";
			}
		} else if (isCortexGroup(activeTab)) {
			const index = indexOfString(CORTEX_TABS, activeTab);
			if (index !== -1) {
				tabFocus.cortexIndex = index;
				tabFocus.cortexFocus = "content";
			}
		}
		return;
	}
}

export function handlePageClick(e: MouseEvent): void {
	const activeTab = nav.activeTab;
	tabFocus.keyboardNavActive = false;

	const target = e.target;
	if (!(target instanceof HTMLElement)) return;

	const pageContent = target.closest('[data-page-content="true"]');
	if (!pageContent) return;

	if (focus.zone !== 'page-content') {
		setFocusZone('page-content');
	}

	const clickedEngineTab = target.closest('[data-engine-tab]');
	const clickedMemoryTab = target.closest('[data-memory-tab]');
	const clickedCortexTab = target.closest('[data-cortex-tab]');

	if (isEngineGroup(activeTab)) {
		const index = indexOfString(ENGINE_TABS, activeTab);
		if (index !== -1) {
			tabFocus.engineIndex = index;
			tabFocus.engineFocus = clickedEngineTab ? "tabs" : "content";
		}
	} else if (isMemoryGroup(activeTab)) {
		const index = indexOfString(MEMORY_TABS, activeTab);
		if (index !== -1) {
			tabFocus.memoryIndex = index;
			tabFocus.memoryFocus = clickedMemoryTab ? "tabs" : "content";
		}
	} else if (isCortexGroup(activeTab)) {
		const index = indexOfString(CORTEX_TABS, activeTab);
		if (index !== -1) {
			tabFocus.cortexIndex = index;
			tabFocus.cortexFocus = clickedCortexTab ? "tabs" : "content";
		}
	}
}

/**
 * Initialize custom event listeners for tab group focus.
 * Call from the page component's onMount. Returns a cleanup function.
 */
export function initTabGroupEffects(): () => void {
	const handleMemoryFocusTabs = () => {
		focusMemoryTab(tabFocus.memoryIndex);
	};
	const handleEngineFocusTabs = () => {
		focusEngineTab(tabFocus.engineIndex);
	};
	const handleCortexFocusTabs = () => {
		focusCortexTab(tabFocus.cortexIndex);
	};
	window.addEventListener("memory-focus-tabs", handleMemoryFocusTabs);
	window.addEventListener("engine-focus-tabs", handleEngineFocusTabs);
	window.addEventListener("cortex-focus-tabs", handleCortexFocusTabs);

	return () => {
		window.removeEventListener("memory-focus-tabs", handleMemoryFocusTabs);
		window.removeEventListener("engine-focus-tabs", handleEngineFocusTabs);
		window.removeEventListener("cortex-focus-tabs", handleCortexFocusTabs);
	};
}
