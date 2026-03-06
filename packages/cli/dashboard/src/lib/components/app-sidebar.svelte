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
import Brain from "@lucide/svelte/icons/brain";
import Cog from "@lucide/svelte/icons/cog";
import Github from "@lucide/svelte/icons/github";
import ListChecks from "@lucide/svelte/icons/list-checks";
import Moon from "@lucide/svelte/icons/moon";
import Sun from "@lucide/svelte/icons/sun";
import Sword from "@lucide/svelte/icons/sword";
import Shield from "@lucide/svelte/icons/shield";
import Scroll from "@lucide/svelte/icons/scroll";
import Zap from "@lucide/svelte/icons/zap";

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

let xpPercent = $derived(Math.min(100, Math.round((memCount / 500) * 100)));

function maybePrefetchEmbeddings(id: string): void {
	if (id !== "memory") return;
	onprefetchembeddings?.();
}

type NavItem =
	| { id: TabId; label: string; icon: typeof Sword; group?: undefined }
	| { id: string; label: string; icon: typeof Sword; group: "memory" | "engine" };

const navItems: NavItem[] = [
	{ id: "config", label: "Character Sheet", icon: Sword },
	{ id: "memory-group", label: "Memory", icon: Scroll, group: "memory" },
	{ id: "secrets", label: "The Vault", icon: Shield },
	{ id: "skills", label: "The Armory", icon: Zap },
	{ id: "tasks", label: "Quest Board", icon: ListChecks },
	{ id: "engine-group", label: "Engine", icon: Cog, group: "engine" },
];

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
</script>

<Sidebar.Root variant="sidebar" collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton class="h-auto py-2 font-[family-name:var(--font-display)]">
					{#snippet child({ props })}
						<div {...props} class="flex items-center gap-3">
							<!-- Hexagonal avatar -->
							<div class="hex-avatar shrink-0" aria-hidden="true">
								<div class="hex-inner">
									{identity?.name?.slice(0,2)?.toUpperCase() ?? 'SG'}
								</div>
							</div>
							<!-- Identity text -->
							<div class="flex flex-col gap-0.5 leading-none overflow-hidden
								transition-[opacity,width] duration-200 ease-out
								group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:w-0">
								<span class="text-[11px] font-bold tracking-[0.12em] uppercase
									text-[var(--sig-text-bright)]">
									SIGNET
								</span>
								<span class="text-[10px] tracking-[0.04em] text-[var(--sig-text-muted)]
									font-[family-name:var(--font-mono)]">
									{identity?.name ?? "Agent"}
								</span>
								<!-- XP bar -->
								<div class="mt-1 h-[var(--xp-bar-height)] w-full
									bg-[var(--xp-bar-bg)] rounded-full overflow-hidden">
									<div class="h-full bg-[var(--xp-bar-fill)] rounded-full
										transition-[width] duration-700 ease-out"
										style="width: {xpPercent}%"></div>
								</div>
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
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={isActive(item)}
								onclick={() => handleClick(item)}
								onmouseenter={() => maybePrefetchEmbeddings(item.id)}
								onfocus={() => maybePrefetchEmbeddings(item.id)}
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
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<div class="flex items-center gap-1.5 px-2 py-1">
					<span
						class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
						class:bg-[var(--rpg-teal)]={!!daemonStatus}
						class:animate-pulse={!!daemonStatus}
						class:border={!daemonStatus}
						class:border-[var(--sig-text-muted)]={!daemonStatus}
					></span>
					<span
						class="text-[10px] tracking-[0.1em] uppercase
							text-[var(--sig-text-muted)]
							font-[family-name:var(--font-mono)]
							overflow-hidden whitespace-nowrap
							transition-opacity duration-200 ease-out
							group-data-[collapsible=icon]:opacity-0"
					>
						{daemonStatus ? "DAEMON ACTIVE" : "DAEMON OFFLINE"}
					</span>
				</div>
			</Sidebar.MenuItem>

			<Sidebar.MenuItem>
			<Sidebar.MenuButton
				onclick={onthemetoggle}
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
			<Sidebar.MenuButton
				onclick={() => window.open("https://github.com/Signet-AI/signetai", "_blank")}
				tooltipContent="GitHub"
			>
					<Github class="size-4" />
					<span class="text-xs font-[family-name:var(--font-mono)]
						overflow-hidden whitespace-nowrap
						transition-opacity duration-200 ease-out
						group-data-[collapsible=icon]:opacity-0"
					>
						GitHub
					</span>
				</Sidebar.MenuButton>
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
								? 'text-[var(--rpg-gold)]'
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
