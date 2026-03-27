<script lang="ts">
import type { DaemonStatus, Harness, Identity } from "$lib/api";
import * as Sidebar from "$lib/components/ui/sidebar/index.js";
import {
	type TabId,
	nav,
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
import Orbit from "@lucide/svelte/icons/orbit";
import Cog from "@lucide/svelte/icons/cog";
import ExternalLink from "@lucide/svelte/icons/external-link";
import Github from "@lucide/svelte/icons/github";
import BarChart3 from "@lucide/svelte/icons/bar-chart-3";
import ShieldAlert from "@lucide/svelte/icons/shield-alert";
import Moon from "@lucide/svelte/icons/moon";
import ShieldCheck from "@lucide/svelte/icons/shield-check";
import Sun from "@lucide/svelte/icons/sun";
import ListTodo from "@lucide/svelte/icons/list-todo";
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
	if (id !== "cortex-memory") return;
	onprefetchembeddings?.();
}

type NavItem = {
	id: TabId;
	focusId: SidebarFocusItem;
	label: string;
	icon: typeof Orbit;
};

const navItems: NavItem[] = [
	{ id: "home", focusId: "home", label: "Overview", icon: BarChart3 },
	{ id: "cortex-memory", focusId: "memory", label: "Ontology", icon: Orbit },
	{ id: "tasks", focusId: "tasks", label: "Tasks", icon: ListTodo },
	{ id: "audit", focusId: "audit", label: "Audit", icon: ShieldAlert },
	{ id: "secrets", focusId: "secrets", label: "Secrets", icon: ShieldCheck },
	{ id: "skills", focusId: "skills", label: "Skills", icon: BookOpen },
];

function openGithub(): void {
	window.open("https://github.com/Signet-AI/signetai", "_blank");
}

function openProjectPage(): void {
	setTab("changelog");
}

function isActive(item: NavItem): boolean {
	return nav.activeTab === item.id;
}

function handleClick(item: NavItem): void {
	if (nav.activeTab === item.id) return;
	setTab(item.id);
}

function focusIdForTab(tab: TabId): SidebarFocusItem {
	if (tab === "settings") return "settings";
	if (tab === "changelog") return "github-link";
	const item = navItems.find((entry) => entry.id === tab);
	if (item) return item.focusId;
	return "home";
}

// Initialize sidebar focus on mount — derive from current active tab
onMount(() => {
	if (!focus.sidebarItem) {
		setSidebarItem(focusIdForTab(nav.activeTab));
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
		if (item === "settings") {
			setTab("settings");
		} else if (item === "theme-toggle") {
			onthemetoggle();
		} else if (item === "github-link") {
			openProjectPage();
		}
	}
}

function activateItem(item: NavItem): void {
	handleClick(item);
	setFocusZone("page-content");
	focusFirstPageElement();
}
</script>

<Sidebar.Root variant="floating" collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					class="h-auto py-2.5 font-[family-name:var(--font-display)]"
					onclick={() => sidebar.toggle()}
				>
					{#snippet child({ props })}
						<div {...props}>
							<img
								src="/logo-dark.png"
								alt=""
								class="sidebar-signet-icon h-5 w-5 shrink-0"
								aria-hidden="true"
							/>
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
									data-sidebar-item={item.focusId}
									tabindex={getTabIndex(item.focusId)}
									isActive={active}
									onclick={() => activateItem(item)}
									onkeydown={(e) => handleSidebarKeydown(e, item)}
									onmouseenter={() => maybePrefetchEmbeddings(item.id)}
									onfocus={() => {
										maybePrefetchEmbeddings(item.id);
										focus.sidebarItem = item.focusId;
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
				<Sidebar.MenuButton
					data-sidebar-item="settings"
					tabindex={getTabIndex("settings")}
					isActive={nav.activeTab === "settings"}
					onclick={() => setTab("settings")}
					onkeydown={(e) => handleFooterKeydown(e, "settings")}
					onfocus={() => { focus.sidebarItem = "settings"; }}
					tooltipContent="Settings"
				>
					<Cog class="size-4" />
					<span class="text-xs font-[family-name:var(--font-mono)]
						overflow-hidden whitespace-nowrap
						transition-opacity duration-200 ease-out
						group-data-[collapsible=icon]:opacity-0"
					>
						Settings
					</span>
				</Sidebar.MenuButton>
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
	 * Machined aluminum nav items — recessed into the panel faceplate.
	 * Sharp edges, inset shadows, physical toggle feel.
	 */

	.nav-blend-item {
		position: relative;
		display: flex;
		align-items: center;
		border-radius: 6px;
		transition: background 0.15s ease, box-shadow 0.15s ease;
	}

	.nav-blend-item:hover:not(.nav-blend-item--active) {
		background: rgba(255, 255, 255, 0.04);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.06),
			inset 0 -1px 0 rgba(0, 0, 0, 0.4);
	}

	:root[data-theme="light"] .nav-blend-item:hover:not(.nav-blend-item--active) {
		background: rgba(0, 0, 0, 0.04);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.nav-blend-item--active {
		background: var(--sig-surface-raised);
		border-radius: 6px;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.07),
			inset 0 -1px 2px rgba(0, 0, 0, 0.5),
			0 1px 0 rgba(255, 255, 255, 0.03);
	}

	:root[data-theme="light"] .nav-blend-item--active {
		box-shadow:
			inset 0 1px 3px rgba(0, 0, 0, 0.1),
			inset 0 0 0 1px rgba(0, 0, 0, 0.04);
	}

	/* Override the active button styling */
	:global(.nav-blend-item--active [data-sidebar="menu-button"]) {
		background: transparent !important;
		color: var(--sig-text-bright) !important;
	}

	/* Sidebar footer separator — etched line */
	:global(.sidebar-carbon-footer) {
		border-top: 1px solid var(--sig-border-strong);
		box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.02);
	}

	:root[data-theme="light"] :global(.sidebar-carbon-footer) {
		box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.4);
	}

	.sidebar-signet-icon {
		filter: drop-shadow(0 0 3px var(--sig-highlight-dim));
		transition: filter var(--dur) var(--ease), transform var(--dur) var(--ease);
	}

	:global([data-theme="light"]) .sidebar-signet-icon {
		filter: invert(1) drop-shadow(0 0 3px var(--sig-highlight-dim));
	}

	:global([data-sidebar="menu-button"]):hover .sidebar-signet-icon {
		filter: drop-shadow(0 0 6px var(--sig-highlight)) drop-shadow(0 0 12px var(--sig-highlight));
		transform: scale(1.15);
	}

	:global([data-theme="light"]) :global([data-sidebar="menu-button"]):hover .sidebar-signet-icon {
		filter: invert(1) drop-shadow(0 0 6px var(--sig-highlight)) drop-shadow(0 0 12px var(--sig-highlight));
		transform: scale(1.15);
	}

	@media (prefers-reduced-motion: reduce) {
		.sidebar-signet-icon {
			transition: none;
		}

		:global([data-sidebar="menu-button"]):hover .sidebar-signet-icon {
			transform: none;
		}
	}
</style>
