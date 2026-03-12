<script lang="ts">
import type { DaemonStatus, Harness, Identity } from "$lib/api";
import * as Sidebar from "$lib/components/ui/sidebar/index.js";
import {
	type TabId,
	isEngineGroup,
	isMemoryGroup,
	nav,
	navigateToGroup,
	setTab,
} from "$lib/stores/navigation.svelte";
import {
	type SidebarFocusItem,
	focus,
	navigateSidebarNext,
	navigateSidebarPrev,
	setFocusZone,
	setSidebarItem,
	focusFirstPageElement,
} from "$lib/stores/focus.svelte";
import BookOpen from "@lucide/svelte/icons/book-open";
import Brain from "@lucide/svelte/icons/brain";
import Cog from "@lucide/svelte/icons/cog";
import ExternalLink from "@lucide/svelte/icons/external-link";
import Github from "@lucide/svelte/icons/github";
import House from "@lucide/svelte/icons/house";
import ListChecks from "@lucide/svelte/icons/list-checks";
import Moon from "@lucide/svelte/icons/moon";
import ShieldCheck from "@lucide/svelte/icons/shield-check";
import Store from "@lucide/svelte/icons/store";
import Sun from "@lucide/svelte/icons/sun";
import { onMount } from "svelte";

const { useSidebar } = Sidebar;

interface Props {
	identity: Identity;
	harnesses: Harness[];
	memCount: number;
	daemonStatus: DaemonStatus | null;
	theme: "dark" | "light";
	onthemetoggle: () => void;
	onprefetchembeddings?: () => void;
}

const {
	identity,
	harnesses,
	memCount,
	daemonStatus,
	theme,
	onthemetoggle,
	onprefetchembeddings,
}: Props = $props();

const sidebar = useSidebar();

function maybePrefetchEmbeddings(id: string): void {
	if (id !== "memory") return;
	onprefetchembeddings?.();
}

type NavItem =
	| { id: TabId; label: string; icon: typeof Brain; group?: undefined }
	| { id: string; label: string; icon: typeof Brain; group: "memory" | "engine" };

const navItems: NavItem[] = [
	{ id: "home", label: "Home", icon: House },
	{ id: "memory-group", label: "Memory", icon: Brain, group: "memory" },
	{ id: "secrets", label: "Secrets", icon: ShieldCheck },
	{ id: "skills", label: "Marketplace", icon: Store },
	{ id: "tasks", label: "Tasks", icon: ListChecks },
	{ id: "engine-group", label: "Engine", icon: Cog, group: "engine" },
];

function openGithub(): void {
	window.open("https://github.com/Signet-AI/signetai", "_blank");
}

function openProjectPage(): void {
	setTab("changelog");
}

function isActive(item: NavItem): boolean {
	if (item.group === "memory") return isMemoryGroup(nav.activeTab);
	if (item.group === "engine") return isEngineGroup(nav.activeTab);
	return nav.activeTab === item.id;
}

function handleClick(item: NavItem): void {
	if (item.group) {
		navigateToGroup(item.group);
	} else {
		setTab(item.id as TabId);
	}
}

// Initialize sidebar focus on mount — derive from current active tab
onMount(() => {
	if (!focus.sidebarItem) {
		const item = navItems.find(n => isActive(n));
		setSidebarItem((item?.id ?? "home") as SidebarFocusItem);
	}
});

function getTabIndex(itemId: SidebarFocusItem): number {
	return focus.sidebarItem === itemId ? 0 : -1;
}

function handleSidebarKeydown(e: KeyboardEvent, item: NavItem): void {
	if (e.key === "ArrowDown") {
		e.preventDefault();
		navigateSidebarNext();
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		navigateSidebarPrev();
	} else if (e.key === "ArrowRight" || e.key === "Enter") {
		e.preventDefault();
		activateItem(item);
	} else if (e.key === " ") {
		e.preventDefault();
		activateItem(item);
	}
}

function handleFooterKeydown(e: KeyboardEvent, item: SidebarFocusItem): void {
	if (e.key === "ArrowDown") {
		e.preventDefault();
		navigateSidebarNext();
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		navigateSidebarPrev();
	} else if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		if (item === "theme-toggle") {
			onthemetoggle();
		} else if (item === "github-link") {
			window.open("https://github.com/Signet-AI/signetai", "_blank");
		}
	}
}

function activateItem(item: NavItem): void {
	handleClick(item);
	setFocusZone("page-content");
	focusFirstPageElement();
}
</script>

<Sidebar.Root variant="sidebar" collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					class="h-auto py-2.5 font-[family-name:var(--font-display)]"
					onclick={() => sidebar.toggle()}
				>
					{#snippet child({ props })}
						<div {...props}>
							<span
								class="sidebar-signet-icon inline-block h-2.5 w-2.5 shrink-0 relative
									before:absolute before:w-px before:h-full before:left-1/2
									before:bg-[var(--sig-highlight)]
									after:absolute after:w-full after:h-px after:top-1/2
									after:bg-[var(--sig-highlight)]"
								style="filter: drop-shadow(0 0 3px var(--sig-highlight-dim));"
								aria-hidden="true"
							></span>
							<div class="flex flex-col gap-0.5 leading-none overflow-hidden
								transition-[opacity,width] duration-200 ease-out
								group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:w-0">
								<span
									class="text-[13px] font-bold tracking-[0.12em]
										uppercase text-[var(--sig-text-bright)]"
								>
									SIGNET
								</span>
								<span
									class="text-[10px] tracking-[0.04em]
										text-[var(--sig-text-muted)]
										font-[family-name:var(--font-mono)]"
								>
									{identity?.name ?? "Agent"}
								</span>
							</div>
						</div>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each navItems as item (item.id)}
						{@const active = isActive(item)}
						<Sidebar.MenuItem>
							<div
								class="nav-blend-item"
								class:nav-blend-item--active={active}
							>
								<Sidebar.MenuButton
									data-sidebar-item={item.id}
									tabindex={getTabIndex(item.id as SidebarFocusItem)}
									isActive={active}
									onclick={() => activateItem(item)}
									onkeydown={(e) => handleSidebarKeydown(e, item)}
									onmouseenter={() => maybePrefetchEmbeddings(item.id)}
									onfocus={() => {
										maybePrefetchEmbeddings(item.id);
										focus.sidebarItem = item.id as SidebarFocusItem;
									}}
									tooltipContent={item.label}
								>
									<item.icon class="size-4" />
									<span class="text-xs uppercase tracking-[0.06em]
										font-[family-name:var(--font-mono)]
										overflow-hidden whitespace-nowrap
										transition-opacity duration-200 ease-out
										group-data-[collapsible=icon]:opacity-0"
									>
										{item.label}
									</span>
								</Sidebar.MenuButton>
							</div>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer class="sidebar-carbon-footer">
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<div class="flex items-center gap-1.5 px-2 py-1">
					<span
						class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
						class:bg-[var(--sig-highlight)]={!!daemonStatus}
						class:border={!daemonStatus}
						class:border-[var(--sig-text-muted)]={!daemonStatus}
						style={daemonStatus ? "box-shadow: 0 0 6px var(--sig-highlight);" : ""}
					></span>
					<span
						class="text-[10px] tracking-[0.1em] uppercase
							text-[var(--sig-text-muted)]
							font-[family-name:var(--font-mono)]
							overflow-hidden whitespace-nowrap
							transition-opacity duration-200 ease-out
							group-data-[collapsible=icon]:opacity-0"
					>
						{daemonStatus ? "ONLINE" : "OFFLINE"}
					</span>
				</div>
			</Sidebar.MenuItem>

			<Sidebar.MenuItem>
			<Sidebar.MenuButton
				data-sidebar-item="theme-toggle"
				tabindex={getTabIndex("theme-toggle")}
				onclick={onthemetoggle}
				onkeydown={(e) => handleFooterKeydown(e, "theme-toggle")}
				onfocus={() => { focus.sidebarItem = "theme-toggle"; }}
				tooltipContent={theme === "dark" ? "Light mode" : "Dark mode"}
			>
					{#if theme === "dark"}
						<Sun class="size-4" />
					{:else}
						<Moon class="size-4" />
					{/if}
					<span class="text-xs font-[family-name:var(--font-mono)]
						overflow-hidden whitespace-nowrap
						transition-opacity duration-200 ease-out
						group-data-[collapsible=icon]:opacity-0"
					>
						{theme === "dark" ? "Light" : "Dark"}
					</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>

			<Sidebar.MenuItem>
				<div class="flex items-center gap-1">
					<Sidebar.MenuButton
						data-sidebar-item="github-link"
						tabindex={getTabIndex("github-link")}
						isActive={nav.activeTab === "changelog"}
						onclick={openProjectPage}
						onkeydown={(e) => handleFooterKeydown(e, "github-link")}
						onfocus={() => { focus.sidebarItem = "github-link"; }}
						tooltipContent="Project"
					>
						<Github class="size-4" />
						<span
							class="text-xs font-[family-name:var(--font-mono)]
								overflow-hidden whitespace-nowrap
								transition-opacity duration-200 ease-out
								group-data-[collapsible=icon]:opacity-0"
						>
							Project
						</span>
					</Sidebar.MenuButton>

					<Sidebar.MenuButton
						class="w-8 shrink-0 justify-center px-0
							group-data-[collapsible=icon]:hidden"
						onclick={openGithub}
						tooltipContent="Open GitHub"
					>
						<ExternalLink class="size-3.5" />
					</Sidebar.MenuButton>
				</div>
			</Sidebar.MenuItem>

			{#if daemonStatus}
				<Sidebar.MenuItem>
					<span
						class="px-2 py-1 text-[10px] tracking-[0.06em]
							font-[family-name:var(--font-mono)]
							overflow-hidden whitespace-nowrap
							transition-opacity duration-200 ease-out
							group-data-[collapsible=icon]:opacity-0
							{daemonStatus.update?.pendingRestart
								? 'text-[var(--sig-warning)]'
								: 'text-[var(--sig-text-muted)]'}"
					>
						{#if daemonStatus.update?.pendingRestart}
							v{daemonStatus.version} → v{daemonStatus.update.pendingRestart}
							<span class="block text-[9px] opacity-70">restart needed</span>
						{:else}
							v{daemonStatus.version}
						{/if}
					</span>
				</Sidebar.MenuItem>
			{/if}
		</Sidebar.Menu>
	</Sidebar.Footer>
</Sidebar.Root>

<style>
	/*
	 * "Blend into page" effect: the active sidebar item extends to the
	 * right edge and visually merges with the main content area, using
	 * rounded cutout corners above and below to form a tab shape.
	 */

	.nav-blend-item {
		position: relative;
		margin-right: -8px; /* extend to the sidebar's right edge */
		border-radius: 6px;
		transition: background 0.2s ease, border-color 0.2s ease;
	}

	.nav-blend-item--active {
		background: var(--sig-surface);
		border-radius: 6px 0 0 6px;
		border-left: 2px solid var(--sig-highlight);
		border-top: 1px solid var(--sig-border-strong);
		border-bottom: 1px solid var(--sig-border-strong);
	}

	/* Rounded cutout above the active item */
	.nav-blend-item--active::before {
		content: "";
		position: absolute;
		right: 0;
		bottom: 100%;
		width: 10px;
		height: 10px;
		background: transparent;
		border-bottom-right-radius: 8px;
		box-shadow: 3px 3px 0 0 var(--sig-surface);
		pointer-events: none;
	}

	/* Rounded cutout below the active item */
	.nav-blend-item--active::after {
		content: "";
		position: absolute;
		right: 0;
		top: 100%;
		width: 10px;
		height: 10px;
		background: transparent;
		border-top-right-radius: 8px;
		box-shadow: 3px -3px 0 0 var(--sig-surface);
		pointer-events: none;
	}

	/* Override the active button styling to match the blend */
	:global(.nav-blend-item--active [data-sidebar="menu-button"]) {
		background: transparent !important;
		color: var(--sig-text-bright) !important;
	}

	/* When collapsed, disable the blend effect */
	:global([data-collapsible="icon"][data-state="collapsed"]) .nav-blend-item {
		margin-right: 0;
	}
	:global([data-collapsible="icon"][data-state="collapsed"]) .nav-blend-item--active {
		background: transparent;
		border-radius: 6px;
		border-left: none;
	}
	:global([data-collapsible="icon"][data-state="collapsed"]) .nav-blend-item--active::before,
	:global([data-collapsible="icon"][data-state="collapsed"]) .nav-blend-item--active::after {
		display: none;
	}

	:global(.sidebar-carbon-footer) {
		background: var(--sig-surface);
		border-top: none;
	}

	.sidebar-signet-icon {
		transition: filter var(--dur) var(--ease), transform var(--dur) var(--ease);
	}

	:global([data-sidebar="menu-button"]):hover .sidebar-signet-icon {
		filter: drop-shadow(0 0 6px var(--sig-highlight)) drop-shadow(0 0 12px var(--sig-highlight));
		transform: scale(1.15);
	}
</style>
