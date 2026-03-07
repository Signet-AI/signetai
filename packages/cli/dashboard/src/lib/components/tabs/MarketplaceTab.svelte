<script lang="ts">
import McpServersTab from "$lib/components/marketplace/McpServersTab.svelte";
import SkillsTab from "$lib/components/tabs/SkillsTab.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import {
	fetchTargetReviews,
	loadMarketplaceReviewConfig,
	reviewsMarket,
	removeMarketplaceReview,
	saveMarketplaceReviewConfig,
	setReviewTarget,
	submitMarketplaceReview,
	syncMarketplaceReviewsNow,
} from "$lib/stores/marketplace-reviews.svelte";
import { toast } from "$lib/stores/toast.svelte";
import {
	fetchMarketplaceMcpCatalog,
	fetchMarketplaceMcpInstalled,
	refreshMarketplaceMcpTools,
	getMarketplaceMcpCategoryOptions,
	mcpMarket,
} from "$lib/stores/marketplace-mcp.svelte";
import {
	fetchCatalog,
	fetchInstalled,
	getCategoryOptions,
	setQuery,
	sk,
} from "$lib/stores/skills.svelte";
import { returnToSidebar } from "$lib/stores/focus.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { onMount } from "svelte";

let section = $state<"skills" | "mcp">("skills");
let sortOpen = $state(true);
let reviewSyncOpen = $state(false);
let refreshingSkills = $state(false);
let refreshingMcp = $state(false);
let refreshingTools = $state(false);
let dropdownOpen = $state(false);
let sortSelectOpen = $state(false);
let secondarySortSelectOpen = $state(false);
let categorySelectOpen = $state(false);
const MOBILE_RAIL_QUERY = "(max-width: 1120px)";

type SpotlightItem = {
	readonly title: string;
	readonly subtitle: string;
	readonly targetType: "skill" | "mcp";
	readonly targetId: string;
};

const activeQuery = $derived(section === "skills" ? sk.query : mcpMarket.query);
const activeSectionLabel = $derived(section === "skills" ? "Agent Skills" : "MCP Tool Servers");
const sectionCatalogCount = $derived(section === "skills" ? sk.catalogTotal : mcpMarket.catalogTotal);
const activeInstalledCount = $derived(section === "skills" ? sk.installed.length : mcpMarket.installed.length);

const skillsFirst = $derived(
	sk.catalog[0]
		? {
			title: sk.catalog[0].name,
			targetType: "skill" as const,
			targetId: sk.catalog[0].name,
		}
		: null,
);

const mcpFirst = $derived(
	mcpMarket.catalog[0]
		? {
			title: mcpMarket.catalog[0].name,
			targetType: "mcp" as const,
			targetId: mcpMarket.catalog[0].id,
		}
		: null,
);

const firstReviewTarget = $derived(section === "skills" ? skillsFirst : mcpFirst);

const categoryOptions = $derived.by(() => {
	if (section === "skills") {
		return getCategoryOptions();
	}
	return getMarketplaceMcpCategoryOptions();
});

const activeCategory = $derived.by(() => {
	if (section === "skills") return sk.categoryFilter;
	return mcpMarket.category;
});

const activeCategoryLabel = $derived(activeCategory === "all" ? "All categories" : activeCategory);
const activeView = $derived(section === "skills" ? sk.view : mcpMarket.view);
const activeSortLabel = $derived.by(() => {
	if (section === "skills") {
		if (sk.sortBy === "installs") return "Downloads";
		if (sk.sortBy === "stars") return "Stars";
		if (sk.sortBy === "name") return "Name";
		if (sk.sortBy === "newest") return "Newest";
		return "Popularity";
	}
	if (mcpMarket.sortBy === "official") return "Official";
	if (mcpMarket.sortBy === "name") return "Name";
	return "Popularity";
});

const activeSecondarySortLabel = $derived.by(() => {
	if (section === "skills") {
		if (sk.providerFilter === "skills.sh") return "skills.sh";
		if (sk.providerFilter === "clawhub") return "ClawHub";
		return "All providers";
	}
	if (mcpMarket.source === "mcpservers.org") return "MCP Registry";
	if (mcpMarket.source === "modelcontextprotocol/servers") return "MCP GitHub";
	return "All sources";
});

function handleSectionChange(value: string): void {
	section = value === "mcp" ? "mcp" : "skills";
}

function updateActiveQuery(value: string): void {
	if (section === "skills") {
		setQuery(value);
		return;
	}
	mcpMarket.query = value;
}

function applyCategory(category: string): void {
	const safe = categoryOptions.includes(category) ? category : "all";
	if (section === "skills") {
		sk.categoryFilter = safe;
		return;
	}
	mcpMarket.category = safe;
}

function applySort(value: string): void {
	if (section === "skills") {
		if (value === "installs" || value === "stars" || value === "name" || value === "newest") {
			sk.sortBy = value;
			return;
		}
		sk.sortBy = "popularity";
		return;
	}
	if (value === "name" || value === "official") {
		mcpMarket.sortBy = value;
		return;
	}
	mcpMarket.sortBy = "popularity";
}

function applySecondarySort(value: string): void {
	if (section === "skills") {
		if (value === "skills.sh" || value === "clawhub") {
			sk.providerFilter = value;
			return;
		}
		sk.providerFilter = "all";
		return;
	}
	if (value === "mcpservers.org" || value === "modelcontextprotocol/servers") {
		mcpMarket.source = value;
		return;
	}
	mcpMarket.source = "all";
}

function clearSectionFilters(): void {
	if (section === "skills") {
		setQuery("");
		sk.categoryFilter = "all";
		sk.providerFilter = "all";
		return;
	}
	mcpMarket.query = "";
	mcpMarket.category = "all";
	mcpMarket.source = "all";
}

function setActiveView(value: "browse" | "installed"): void {
	if (section === "skills") {
		sk.view = value;
		return;
	}
	mcpMarket.view = value;
}

function hasUsedTarget(targetType: "skill" | "mcp", targetId: string): boolean {
	if (targetType === "skill") {
		return sk.installed.some((s) => s.name === targetId);
	}
	return mcpMarket.installed.some((s) => (s.catalogId ? `${s.source}:${s.catalogId}` === targetId : false));
}

async function handleReviewRequest(payload: {
	targetType: "skill" | "mcp";
	targetId: string;
	targetLabel: string;
}): Promise<void> {
	const canReview = hasUsedTarget(payload.targetType, payload.targetId);
	await setReviewTarget(payload.targetType, payload.targetId, payload.targetLabel, {
		canReview,
		reason: "Install or use this app before leaving a review.",
	});
	if (!canReview) {
		toast("Install or use this app before leaving a review.", "error");
	}
}

async function refreshSkills(): Promise<void> {
	refreshingSkills = true;
	try {
		sk.catalogLoaded = false;
		await Promise.all([fetchInstalled(), fetchCatalog()]);
	} finally {
		refreshingSkills = false;
	}
}

async function refreshMcpServers(): Promise<void> {
	refreshingMcp = true;
	try {
		mcpMarket.catalogLoaded = false;
		await Promise.all([fetchMarketplaceMcpInstalled(), fetchMarketplaceMcpCatalog(5)]);
	} finally {
		refreshingMcp = false;
	}
}

async function refreshRoutedToolsNow(): Promise<void> {
	refreshingTools = true;
	try {
		await refreshMarketplaceMcpTools(true);
	} finally {
		refreshingTools = false;
	}
}

// Navigation mode: "tabs" (Agent Skills/MCP Servers), "cards" (app drawer), or "filters" (rail panel)
type NavMode = "tabs" | "cards" | "filters";
let navMode = $state<NavMode>("tabs");
let focusedCardIndex = $state(-1);
let focusedFilterIndex = $state(0);

// Get all focusable cards in current section
function getCards(): HTMLElement[] {
	return Array.from(
		section === "skills"
			? document.querySelectorAll('.card-wrap .card')
			: document.querySelectorAll('.catalog-card')
	) as HTMLElement[];
}

// Get all focusable filter elements in the rail in DOM order
function getFilterElements(): HTMLElement[] {
	const rail = document.querySelector('.store-rail');
	if (!rail) return [];

	// Get all interactive elements in DOM order for sequential navigation
	// This matches how they appear visually so Arrow Down goes through each one
	const allFocusable = rail.querySelectorAll(
		'.rail-select, .rail-btn, .sync-actions button, .hero-switch, .toggle-row input, .input'
	);
	return (Array.from(allFocusable) as HTMLElement[]).filter(
		(el) => !(el as HTMLButtonElement).disabled
	);
}

// Calculate grid dimensions for 2D navigation
function getGridInfo(): { columns: number; cards: HTMLElement[] } {
	const cards = getCards();
	if (cards.length === 0) return { columns: 1, cards };

	// Find the grid container
	const gridContainer = cards[0]?.parentElement;
	if (!gridContainer) return { columns: 1, cards };

	// Calculate columns by checking card positions
	const firstCardRect = cards[0].getBoundingClientRect();
	let columns = 1;
	for (let i = 1; i < cards.length; i++) {
		const cardRect = cards[i].getBoundingClientRect();
		if (Math.abs(cardRect.top - firstCardRect.top) < 2) {
			columns++;
		} else {
			break;
		}
	}

	return { columns, cards };
}

// Keyboard navigation
function handleGlobalKey(e: KeyboardEvent) {
	// Only handle events when Marketplace (skills) tab is active
	if (nav.activeTab !== "skills") return;

	if (e.defaultPrevented) return;

	const target = e.target as HTMLElement;
	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	if (isInputFocused) return;

	// If a dropdown is open, let it handle its own navigation
	// Only intercept Escape and ArrowLeft to close the dropdown
	if (dropdownOpen) {
		if (e.key === "Escape" || e.key === "ArrowLeft") {
			// Close dropdown and return to filter navigation
			e.preventDefault();
			e.stopPropagation();
			dropdownOpen = false;
			sortSelectOpen = false;
			secondarySortSelectOpen = false;
			categorySelectOpen = false;
			// Re-focus the current filter button
			const filters = getFilterElements();
			if (filters[focusedFilterIndex]) {
				filters[focusedFilterIndex].focus();
			}
			return;
		}
		// Let the dropdown handle Arrow Up/Down for option navigation
		return;
	}

	// Escape handling - check detail views first
	if (e.key === "Escape") {
		const detailOpen = sk.detailOpen || mcpMarket.catalogDetail;
		if (detailOpen) {
			// Let child components handle closing their detail views
			return;
		}

		// In cards mode, return to tabs mode
		if (navMode === "cards") {
			e.preventDefault();
			navMode = "tabs";
			focusedCardIndex = -1;
			// Blur any focused card
			const cards = getCards();
			cards.forEach(c => c.blur());
			return;
		}

		// In filters mode, return to cards mode
		if (navMode === "filters") {
			e.preventDefault();
			navMode = "cards";
			focusedFilterIndex = 0;
			// Blur any focused filter
			const filters = getFilterElements();
			filters.forEach(f => f.blur());
			// Focus the last card in the visible row
			const { columns, cards } = getGridInfo();
			if (cards.length > 0) {
				const lastIndex = Math.min(columns - 1, cards.length - 1);
				focusedCardIndex = lastIndex;
				cards[lastIndex]?.focus();
			}
			return;
		}

		// No detail open and in tabs mode, return to sidebar
		e.preventDefault();
		returnToSidebar();
		return;
	}

	// Tab navigation mode (Agent Skills / MCP Servers switching)
	if (navMode === "tabs") {
		// Arrow Down - enter cards mode
		if (e.key === "ArrowDown") {
			e.preventDefault();
			navMode = "cards";
			const cards = getCards();
			if (cards.length > 0) {
				focusedCardIndex = 0;
				cards[0]?.focus();
			}
			return;
		}

		// Arrow Left - switch sections or return to sidebar
		if (e.key === "ArrowLeft") {
			if (section === "skills") {
				e.preventDefault();
				returnToSidebar();
				return;
			}

			if (section === "mcp") {
				e.preventDefault();
				handleSectionChange("skills");
			}
			return;
		}

		// Arrow Right - switch to MCP Servers from Agent Skills
		if (e.key === "ArrowRight" && section === "skills") {
			e.preventDefault();
			handleSectionChange("mcp");
			return;
		}

		return;
	}

	// Cards navigation mode (2D grid navigation)
	if (navMode === "cards") {
		const { columns, cards } = getGridInfo();

		// Arrow Down - navigate down in grid
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (cards.length === 0) return;

			// If no card focused, focus first
			if (focusedCardIndex === -1) {
				focusedCardIndex = 0;
				cards[0]?.focus();
				return;
			}

			// Navigate down (add columns to index)
			const newIndex = focusedCardIndex + columns;
			if (newIndex < cards.length) {
				focusedCardIndex = newIndex;
				cards[newIndex]?.focus();
			}
			return;
		}

		// Arrow Up - navigate up in grid
		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (cards.length === 0 || focusedCardIndex === -1) return;

			// Navigate up (subtract columns from index)
			const newIndex = focusedCardIndex - columns;
			if (newIndex >= 0) {
				focusedCardIndex = newIndex;
				cards[newIndex]?.focus();
			} else if (focusedCardIndex < columns) {
				// On first row, return to tabs mode
				navMode = "tabs";
				cards[focusedCardIndex]?.blur();
				focusedCardIndex = -1;
			}
			return;
		}

		// Arrow Left - navigate left in grid, or to previous section
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			if (cards.length === 0) return;

			// If no card focused or on first card of row
function handleGlobalKey(e: KeyboardEvent) {
	// Only handle events when Marketplace (skills) tab is active
	if (nav.activeTab !== "skills") return;

	if (e.defaultPrevented) return;

	const target = e.target as HTMLElement;

				if (section === "skills") {
					returnToSidebar();
				} else if (section === "mcp") {
					handleSectionChange("skills");
				}
				return;
			}

			// Check if we're at the start of a row
			if (focusedCardIndex % columns === 0) {
				// At start of row, return to tabs mode
				navMode = "tabs";
				focusedCardIndex = -1;
				cards.forEach(c => c.blur());
				return;
			}

			// Navigate left
			focusedCardIndex--;
			cards[focusedCardIndex]?.focus();
			return;
		}

		// Arrow Right - navigate right in grid, or to filters
		if (e.key === "ArrowRight") {
			e.preventDefault();
			if (cards.length === 0) return;

			// If no card focused, focus first
			if (focusedCardIndex === -1) {
				focusedCardIndex = 0;
				cards[0]?.focus();
				return;
			}

			// Check if we're at the end of a row (or last card)
			const isAtEndOfRow = (focusedCardIndex + 1) % columns === 0;
			const isLastCard = focusedCardIndex === cards.length - 1;

			if (isAtEndOfRow || isLastCard) {
				// Move to filters panel
				navMode = "filters";
				focusedFilterIndex = 0;
				cards.forEach(c => c.blur());

				const filters = getFilterElements();
				if (filters.length > 0) {
					filters[0]?.focus();
				}
				return;
			}

			// Navigate right
			focusedCardIndex++;
			cards[focusedCardIndex]?.focus();
			return;
		}

		return;
	}

	// Filters navigation mode
	if (navMode === "filters") {
		const filters = getFilterElements();

		// Arrow Up - navigate up in filters (don't open)
		if (e.key === "ArrowUp") {
			e.preventDefault();
			e.stopPropagation();
			if (filters.length === 0) return;

			if (focusedFilterIndex > 0) {
				focusedFilterIndex--;
				filters[focusedFilterIndex]?.focus();
			}
			return;
		}

		// Arrow Down - navigate down in filters (don't open)
		if (e.key === "ArrowDown") {
			e.preventDefault();
			e.stopPropagation();
			if (filters.length === 0) return;

			if (focusedFilterIndex < filters.length - 1) {
				focusedFilterIndex++;
				filters[focusedFilterIndex]?.focus();
			}
			return;
		}

		// Arrow Left or Escape - return to cards mode
		if (e.key === "ArrowLeft" || e.key === "Escape") {
			e.preventDefault();
			navMode = "cards";
			focusedFilterIndex = 0;
			filters.forEach(f => f.blur());

			const { columns, cards } = getGridInfo();
			if (cards.length > 0) {
				// Focus the last card in the first visible row
				const lastIndex = Math.min(columns - 1, cards.length - 1);
				focusedCardIndex = lastIndex;
				cards[lastIndex]?.focus();
			}
			return;
		}

		// Arrow Right - move to next section (already at filters, so exit right)
		if (e.key === "ArrowRight") {
			// If on a filter button, let it handle opening via Enter
			// If the filter is already open, this moves to next section (no action needed)
			// The select components will handle their own dropdown navigation
			return;
		}

		// Enter - open the focused filter element
		if (e.key === "Enter") {
			// Let the select/button handle Enter naturally to open
			return;
		}

		return;
	}
}

onMount(() => {
	const media = window.matchMedia(MOBILE_RAIL_QUERY);
	const applyRailLayoutState = (): void => {
		if (media.matches) {
			sortOpen = false;
			reviewSyncOpen = false;
			return;
		}
		sortOpen = true;
		reviewSyncOpen = false;
	};

	applyRailLayoutState();
	media.addEventListener("change", applyRailLayoutState);

	void fetchInstalled();
	void fetchCatalog();
	void fetchMarketplaceMcpInstalled();
	void fetchMarketplaceMcpCatalog(5);
	void refreshMarketplaceMcpTools();
	void loadMarketplaceReviewConfig();

	// Focus tracking for cards - use event delegation on document
	function handleCardFocus(e: FocusEvent): void {
		const target = e.target as HTMLElement;
		if (!target) return;

		// Check if focus landed on a card
		const cards = getCards();
		const cardIndex = cards.indexOf(target);
		if (cardIndex !== -1) {
			navMode = "cards";
			focusedCardIndex = cardIndex;
			return;
		}

		// Check if focus landed on a filter element
		const filters = getFilterElements();
		const filterIndex = filters.indexOf(target);
		if (filterIndex !== -1) {
			navMode = "filters";
			focusedFilterIndex = filterIndex;
			return;
		}
	}

	document.addEventListener("focusin", handleCardFocus);

	return () => {
		media.removeEventListener("change", applyRailLayoutState);
		document.removeEventListener("focusin", handleCardFocus);
	};
});

$effect(() => {
	if (!firstReviewTarget) return;
	if (reviewsMarket.targetId && reviewsMarket.targetType) return;
	void setReviewTarget(firstReviewTarget.targetType, firstReviewTarget.targetId, firstReviewTarget.title, {
		canReview: hasUsedTarget(firstReviewTarget.targetType, firstReviewTarget.targetId),
		reason: "Install or use this app before leaving a review.",
	});
});

$effect(() => {
	if (!reviewsMarket.targetType || !reviewsMarket.targetId) return;
	void fetchTargetReviews();
});
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="store-shell">
	<section class="hero">
		<div class="hero-main">
			<h2>
				{section === "skills"
					? "Discover skill packs that level up your agent workflow"
					: "Browse MCP servers and route production tools with confidence"}
			</h2>
			<p>
				{section === "skills"
					? "Install trusted skills, compare options, and rate what actually delivers results."
					: "Connect tool servers, monitor routed tools, and leave Signet Reviews for your stack."}
			</p>
			<div class="hero-actions">
				<Button
					variant="outline"
					size="sm"
					class={`hero-switch ${section === "skills" ? "hero-switch-active" : ""}`}
					onclick={() => handleSectionChange("skills")}
					onkeydown={(e) => {
						if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
							e.stopPropagation();
							handleGlobalKey(e);
							e.preventDefault();
						}
					}}
				>
					Agent Skills
				</Button>
				<Button
					variant="outline"
					size="sm"
					class={`hero-switch ${section === "mcp" ? "hero-switch-active" : ""}`}
					onclick={() => handleSectionChange("mcp")}
					onkeydown={(e) => {
						if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
							e.stopPropagation();
							handleGlobalKey(e);
							e.preventDefault();
						}
					}}
				>
					MCP Servers
				</Button>
			</div>
		</div>
		<div class="hero-aside">
			<div class="hero-metric"><span>Active section</span><strong>{activeSectionLabel} · {activeInstalledCount} installed</strong></div>
			<div class="hero-metric"><span>Catalog size</span><strong>{sectionCatalogCount.toLocaleString()}</strong></div>
			<div class="hero-metric"><span>Signet Reviews</span><strong>{reviewsMarket.summary.count} reviews</strong></div>
		</div>
	</section>

	<div class="store-grid">
		<main class="store-main">
			<div class="module-head">
				<div class="module-search-wrap">
					<div class="module-search-inner">
						<input
							type="text"
							class="module-search"
							placeholder={section === "skills" ? "Search skills..." : "Search MCP servers..."}
							value={activeQuery}
							oninput={(e) => updateActiveQuery(e.currentTarget.value)}
						/>
						<Button variant="outline" size="sm" class="search-clear" onclick={clearSectionFilters}>Clear</Button>
					</div>
				</div>
				<div class="module-view-tabs">
					<Button
						variant="outline"
						size="sm"
						class={`view-tab ${activeView === "browse" ? "view-tab-active" : ""}`}
						onclick={() => setActiveView("browse")}
					>
						Browse
					</Button>
					<Button
						variant="outline"
						size="sm"
						class={`view-tab ${activeView === "installed" ? "view-tab-active" : ""}`}
						onclick={() => setActiveView("installed")}
					>
						Installed
					</Button>
				</div>
			</div>

			<div class="module-body">
				{#if section === "skills"}
					<SkillsTab embedded={true} showViewTabs={false} onreviewrequest={handleReviewRequest} />
				{:else}
					<McpServersTab
						embedded={true}
						showViewTabs={false}
						currentView={activeView}
						onviewchange={(v) => setActiveView(v)}
						onreviewrequest={handleReviewRequest}
					/>
				{/if}
			</div>
		</main>

		<aside class="store-rail">
			<Collapsible.Root bind:open={sortOpen} class="rail-panel">
				<Collapsible.Trigger class="rail-trigger">
					<span>Sort</span>
					<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${sortOpen ? "rotate-180" : ""}`} />
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="rail-content">
						<Select.Root
							type="single"
							value={section === "skills" ? sk.sortBy : mcpMarket.sortBy}
							onValueChange={(v) => applySort(v ?? "popularity")}
							open={sortSelectOpen}
							onOpenChange={(open) => {
								sortSelectOpen = open;
								dropdownOpen = open;
							}}
						>
							<Select.Trigger
								class="rail-select"
								onkeydown={(e) => {
									// Prevent arrow keys from opening dropdown - only Enter should open
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.stopPropagation();
										handleGlobalKey(e);
										e.preventDefault();
									}
									// Let Enter open the dropdown naturally
								}}
							>{activeSortLabel}</Select.Trigger>
							<Select.Content class="section-select-content">
								{#if section === "skills"}
									<Select.Item value="popularity" label="Popularity" class="section-select-item" />
									<Select.Item value="installs" label="Downloads" class="section-select-item" />
									<Select.Item value="stars" label="Stars" class="section-select-item" />
									<Select.Item value="name" label="Name" class="section-select-item" />
									<Select.Item value="newest" label="Newest" class="section-select-item" />
								{:else}
									<Select.Item value="popularity" label="Popularity" class="section-select-item" />
									<Select.Item value="official" label="Official" class="section-select-item" />
									<Select.Item value="name" label="Name" class="section-select-item" />
								{/if}
							</Select.Content>
						</Select.Root>

						<Select.Root
							type="single"
							value={section === "skills" ? sk.providerFilter : mcpMarket.source}
							onValueChange={(v) => applySecondarySort(v ?? "all")}
							open={secondarySortSelectOpen}
							onOpenChange={(open) => {
								secondarySortSelectOpen = open;
								dropdownOpen = open;
							}}
						>
							<Select.Trigger
								class="rail-select"
								onkeydown={(e) => {
									// Prevent arrow keys from opening dropdown - only Enter should open
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.stopPropagation();
										handleGlobalKey(e);
										e.preventDefault();
									}
									// Let Enter open the dropdown naturally
								}}
							>{activeSecondarySortLabel}</Select.Trigger>
							<Select.Content class="section-select-content">
								{#if section === "skills"}
									<Select.Item value="all" label="All providers" class="section-select-item" />
									<Select.Item value="skills.sh" label="skills.sh" class="section-select-item" />
									<Select.Item value="clawhub" label="ClawHub" class="section-select-item" />
								{:else}
									<Select.Item value="all" label="All sources" class="section-select-item" />
									<Select.Item value="mcpservers.org" label="MCP Registry" class="section-select-item" />
									<Select.Item value="modelcontextprotocol/servers" label="MCP GitHub" class="section-select-item" />
								{/if}
							</Select.Content>
						</Select.Root>

						<Select.Root
							type="single"
							value={activeCategory}
							onValueChange={(v) => applyCategory(v ?? "all")}
							open={categorySelectOpen}
							onOpenChange={(open) => {
								categorySelectOpen = open;
								dropdownOpen = open;
							}}
						>
							<Select.Trigger
								class="rail-select"
								onkeydown={(e) => {
									// Prevent arrow keys from opening dropdown - only Enter should open
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.stopPropagation();
										handleGlobalKey(e);
										e.preventDefault();
									}
									// Let Enter open the dropdown naturally
								}}
							>{activeCategoryLabel}</Select.Trigger>
							<Select.Content class="section-select-content">
								{#each categoryOptions as category (category)}
									<Select.Item value={category} label={category} class="section-select-item" />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</Collapsible.Content>
			</Collapsible.Root>

			<Collapsible.Root bind:open={reviewSyncOpen} class="rail-panel">
				<Collapsible.Trigger class="rail-trigger">
					<span>Sync</span>
					<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${reviewSyncOpen ? "rotate-180" : ""}`} />
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="rail-content">
						<div class="rail-refresh">
							<Button
								variant="outline"
								size="sm"
								class="rail-btn"
								disabled={refreshingSkills}
								onclick={refreshSkills}
								onkeydown={(e) => {
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.stopPropagation();
										handleGlobalKey(e);
										e.preventDefault();
									}
								}}
							>
								{refreshingSkills ? "Refreshing Skills..." : "Refresh Skills"}
							</Button>
							<Button
								variant="outline"
								size="sm"
								class="rail-btn"
								disabled={refreshingMcp}
								onclick={refreshMcpServers}
								onkeydown={(e) => {
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.stopPropagation();
										handleGlobalKey(e);
										e.preventDefault();
									}
								}}
							>
								{refreshingMcp ? "Refreshing MCP Servers..." : "Refresh MCP Servers"}
							</Button>
							<Button
								variant="outline"
								size="sm"
								class="rail-btn"
								disabled={refreshingTools}
								onclick={refreshRoutedToolsNow}
								onkeydown={(e) => {
									if (e.key === "ArrowUp" || e.key === "ArrowDown") {
										e.stopPropagation();
										handleGlobalKey(e);
										e.preventDefault();
									}
								}}
							>
								{refreshingTools ? "Refreshing Routed Tools..." : "Refresh Routed Tools"}
							</Button>
						</div>

				<label class="toggle-row">
					<input
						type="checkbox"
						bind:checked={reviewsMarket.configEnabled}
					/>
					<span>Enable endpoint sync</span>
				</label>
				<input
					type="url"
					class="input"
					placeholder="https://example.com/signet-reviews"
					bind:value={reviewsMarket.configEndpointUrl}
				/>
				<div class="sync-actions">
					<Button
						variant="outline"
						size="sm"
						disabled={reviewsMarket.configSaving}
						onclick={saveMarketplaceReviewConfig}
						onkeydown={(e) => {
							if (e.key === "ArrowUp" || e.key === "ArrowDown") {
								e.stopPropagation();
								handleGlobalKey(e);
								e.preventDefault();
							}
						}}
					>
						{reviewsMarket.configSaving ? "Saving..." : "Save Sync Config"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={reviewsMarket.syncing}
						onclick={syncMarketplaceReviewsNow}
						onkeydown={(e) => {
							if (e.key === "ArrowUp" || e.key === "ArrowDown") {
								e.stopPropagation();
								handleGlobalKey(e);
								e.preventDefault();
							}
						}}
					>
						{reviewsMarket.syncing ? "Syncing..." : `Sync Now (${reviewsMarket.pendingSync})`}
					</Button>
				</div>
				{#if reviewsMarket.lastSyncAt}
					<div class="muted">Last sync: {new Date(reviewsMarket.lastSyncAt).toLocaleString()}</div>
				{/if}
				{#if reviewsMarket.lastSyncError}
					<div class="error">{reviewsMarket.lastSyncError}</div>
				{/if}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</aside>
	</div>
</div>

<style>
	.store-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow: hidden;
		padding: 10px;
	}

	.hero,
	.store-main,
	:global(.rail-panel) {
		border: none;
		background: var(--sig-surface);
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 10px;
		padding: 14px;
		background:
			radial-gradient(circle at 85% -20%, color-mix(in srgb, var(--sig-accent) 16%, transparent), transparent 45%),
			linear-gradient(140deg, color-mix(in srgb, var(--sig-surface-raised) 88%, black) 0%, var(--sig-surface) 65%);
	}

	.hero-main h2 {
		margin: 8px 0 4px;
		font-size: clamp(19px, 2vw, 27px);
		line-height: 1.15;
	}

	.hero-main p {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.55;
		color: var(--sig-text);
	}

	.hero-aside {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.hero-metric {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px;
		background: color-mix(in srgb, var(--sig-surface-raised) 55%, transparent);
		border-radius: 0.45rem;
	}

	.hero-metric span {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.hero-metric strong {
		font-family: var(--font-display);
		font-size: 11px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.module-search,
	.input,
	:global(.section-select) {
		height: 34px;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		outline: none;
		border-radius: 0.5rem;
		transition: border-color 0.15s;
	}

	.module-search:hover,
	.input:hover {
		border-color: var(--sig-accent);
	}

	.module-search:focus,
	.input:focus {
		border-color: var(--sig-accent);
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	:global(.section-select-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	:global(.section-select-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.store-grid {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 250px;
		gap: 10px;
	}

	.store-main {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	.module-head {
		display: grid;
		grid-template-columns: minmax(260px, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 0 8px;
		margin-bottom: 8px;
	}

	.module-search {
		height: 30px;
		min-width: 0;
		width: 100%;
		padding-right: 72px;
	}

	.module-search-wrap {
		display: block;
	}

	.module-search-inner {
		position: relative;
		display: flex;
		align-items: center;
	}

	:global(.search-clear) {
		position: absolute;
		right: 4px;
		height: 22px;
		min-height: 22px;
		padding: 0 8px;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.module-view-tabs {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	:global(.view-tab) {
		height: 30px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		transition: border-color 0.15s;
	}

	:global(.view-tab:hover) {
		border-color: var(--sig-accent);
	}

	:global(.view-tab:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	:global(.view-tab.view-tab-active) {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
	}

	.hero-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	:global(.hero-switch) {
		height: 30px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		transition: border-color 0.15s, background-color 0.15s;
	}

	:global(.hero-switch:hover) {
		border-color: var(--sig-accent);
	}

	:global(.hero-switch:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	:global(.hero-switch.hero-switch-active) {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
		background: color-mix(in srgb, var(--sig-surface-raised) 84%, transparent);
	}

	.module-body {
		flex: 1;
		min-height: 0;
	}

	.store-rail {
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow-y: auto;
		padding-top: 2px;
		justify-self: center;
		width: 100%;
		max-width: 250px;
	}

	:global(.rail-panel) {
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: color-mix(in srgb, var(--sig-surface-raised) 35%, transparent);
		border-radius: 0.5rem;
	}

	:global(.rail-trigger) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 2px 0;
		background: transparent;
		border: none;
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sig-text-bright);
		cursor: pointer;
		transition: color 0.15s;
	}

	:global(.rail-trigger:hover) {
		color: var(--sig-accent);
	}

	:global(.rail-trigger:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 2px;
	}

	:global(.rail-content) {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 6px;
	}

	:global(.rail-select) {
		height: 32px;
		width: 100%;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
		transition: border-color 0.15s, outline-color 0.15s;
	}

	:global(.rail-select:hover) {
		border-color: var(--sig-accent);
	}

	:global(.rail-select:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	.rail-refresh {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 4px;
	}

	:global(.rail-btn) {
		justify-content: flex-start;
		font-family: var(--font-mono);
		font-size: 10px;
		height: 30px;
		transition: border-color 0.15s, outline-color 0.15s;
	}

	:global(.rail-btn:hover) {
		border-color: var(--sig-accent);
	}

	:global(.rail-btn:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	.muted {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.toggle-row span,
	.error {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.toggle-row span {
		color: var(--sig-text-muted);
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.toggle-row input[type="checkbox"] {
		width: 16px;
		height: 16px;
		cursor: pointer;
		accent-color: var(--sig-accent);
	}

	.toggle-row input[type="checkbox"]:focus-visible {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	.sync-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.sync-actions :global(button) {
		transition: border-color 0.15s;
	}

	.sync-actions :global(button:hover) {
		border-color: var(--sig-accent);
	}

	.sync-actions :global(button:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
	}

	.error {
		color: var(--sig-danger);
	}

	@media (max-width: 1120px) {
		.store-grid {
			grid-template-columns: 1fr;
		}

		.store-rail {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 8px;
			max-width: none;
			max-height: none;
		}

		:global(.rail-panel) {
			min-height: 0;
		}
	}

	@media (max-width: 980px) {
		.hero {
			grid-template-columns: 1fr;
		}

		.module-head {
			grid-template-columns: 1fr;
		}

		.module-search-wrap {
			display: block;
		}
	}
</style>
