<script lang="ts">
	import type { DaemonStatus, Identity, Harness } from "$lib/api";
	import { nav, setTab, type TabId } from "$lib/stores/navigation.svelte";
	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
	import FileText from "@lucide/svelte/icons/file-text";
	import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
	import Database from "@lucide/svelte/icons/database";
	import Network from "@lucide/svelte/icons/network";
	import ScrollText from "@lucide/svelte/icons/scroll-text";
	import KeyRound from "@lucide/svelte/icons/key-round";
	import Zap from "@lucide/svelte/icons/zap";
	import CalendarClock from "@lucide/svelte/icons/calendar-clock";
	import Activity from "@lucide/svelte/icons/activity";
	import Plug from "@lucide/svelte/icons/plug";
	import Sun from "@lucide/svelte/icons/sun";
	import Moon from "@lucide/svelte/icons/moon";
	import Github from "@lucide/svelte/icons/github";

	interface Props {
		identity: Identity;
		harnesses: Harness[];
		memCount: number;
		daemonStatus: DaemonStatus | null;
		theme: "dark" | "light";
		onthemetoggle: () => void;
	}

	let {
		identity,
		harnesses,
		memCount,
		daemonStatus,
		theme,
		onthemetoggle,
	}: Props = $props();

	const navItems: { id: TabId; label: string; icon: typeof FileText }[] = [
		{ id: "config", label: "Config", icon: FileText },
		{ id: "settings", label: "Settings", icon: SlidersHorizontal },
		{ id: "memory", label: "Memory", icon: Database },
		{ id: "embeddings", label: "Constellation", icon: Network },
		{ id: "pipeline", label: "Pipeline", icon: Activity },
		{ id: "logs", label: "Logs", icon: ScrollText },
		{ id: "secrets", label: "Secrets", icon: KeyRound },
		{ id: "skills", label: "Skills", icon: Zap },
		{ id: "tasks", label: "Tasks", icon: CalendarClock },
		{ id: "connectors", label: "Connectors", icon: Plug },
	];
</script>

<Sidebar.Root variant="sidebar" collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton class="h-auto py-2.5 font-[family-name:var(--font-display)]">
					{#snippet child({ props })}
						<div {...props}>
							<span
								class="inline-block h-2.5 w-2.5 shrink-0 relative
									before:absolute before:w-px before:h-full before:left-1/2
									before:bg-[var(--sig-accent)]
									after:absolute after:w-full after:h-px after:top-1/2
									after:bg-[var(--sig-accent)]"
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
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={nav.activeTab === item.id}
								onclick={() => setTab(item.id)}
								tooltip={item.label}
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
						class="inline-block h-1.5 w-1.5 shrink-0"
						class:bg-[var(--sig-success)]={!!daemonStatus}
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
						{daemonStatus ? "ONLINE" : "OFFLINE"}
					</span>
				</div>
			</Sidebar.MenuItem>

			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					onclick={onthemetoggle}
					tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
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
					tooltip="GitHub"
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
							text-[var(--sig-text-muted)]
							font-[family-name:var(--font-mono)]
							overflow-hidden whitespace-nowrap
							transition-opacity duration-200 ease-out
							group-data-[collapsible=icon]:opacity-0"
					>
						v{daemonStatus.version}
					</span>
				</Sidebar.MenuItem>
			{/if}
		</Sidebar.Menu>
	</Sidebar.Footer>
</Sidebar.Root>
