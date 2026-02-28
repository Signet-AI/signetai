<script lang="ts">
	import { Dialog as CommandPrimitive } from "bits-ui";
	import { nav, type TabId } from "$lib/stores/navigation.svelte";
	import { ActionLabels } from "$lib/ui/action-labels";
	import Search from "@lucide/svelte/icons/search";

	interface CommandItem {
		id: string;
		label: string;
		shortcut?: string;
		action: () => void;
	}

	let open = $state(false);
	let query = $state("");
	let selectedIndex = $state(0);

	const tabItems: CommandItem[] = [
		{ id: "config", label: "Identity Files", shortcut: "1", action: () => setTabAndClose("config") },
		{ id: "settings", label: "Settings", shortcut: "2", action: () => setTabAndClose("settings") },
		{ id: "memory", label: "Memory", shortcut: "3", action: () => setTabAndClose("memory") },
		{ id: "embeddings", label: "Embeddings", shortcut: "4", action: () => setTabAndClose("embeddings") },
		{ id: "pipeline", label: "Pipeline", shortcut: "5", action: () => setTabAndClose("pipeline") },
		{ id: "logs", label: "Logs", shortcut: "6", action: () => setTabAndClose("logs") },
		{ id: "secrets", label: "Secrets", shortcut: "7", action: () => setTabAndClose("secrets") },
		{ id: "skills", label: "Skills", shortcut: "8", action: () => setTabAndClose("skills") },
		{ id: "tasks", label: "Tasks", shortcut: "9", action: () => setTabAndClose("tasks") },
	];

	const actionItems: CommandItem[] = [
		{ id: "toggle-theme", label: "Toggle Theme", action: () => {} },
		{ id: "refresh", label: ActionLabels.Refresh, action: () => window.location.reload() },
	];

	const filteredItems = $derived.by(() => {
		const q = query.toLowerCase().trim();
		if (!q) return [...tabItems, ...actionItems];
		return [...tabItems, ...actionItems].filter(item => 
			item.label.toLowerCase().includes(q)
		);
	});

	function setTabAndClose(tab: TabId) {
		nav.activeTab = tab;
		open = false;
		query = "";
		selectedIndex = 0;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % filteredItems.length;
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + filteredItems.length) % filteredItems.length;
		} else if (e.key === "Enter") {
			e.preventDefault();
			const item = filteredItems[selectedIndex];
			if (item) item.action();
		} else if (e.key === "Escape") {
			open = false;
		}
	}

	$effect(() => {
		if (open) {
			selectedIndex = 0;
		}
	});

	$effect(() => {
		selectedIndex = 0;
	});

	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === "k") {
			e.preventDefault();
			open = !open;
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<CommandPrimitive.Root bind:open>
	<CommandPrimitive.Portal>
		<CommandPrimitive.Overlay class="fixed inset-0 z-50 bg-black/60" />
		<CommandPrimitive.Content class="fixed left-1/2 top-[20%] z-50 w-full max-w-[480px] -translate-x-1/2 rounded-none border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] shadow-xl">
			<div class="flex items-center border-b border-[var(--sig-border)] px-3">
				<Search class="size-4 shrink-0 text-[var(--sig-text-muted)]" />
				<input
					type="text"
					class="flex-1 bg-transparent px-3 py-3 text-[12px] font-[family-name:var(--font-mono)] text-[var(--sig-text-bright)] outline-none placeholder:text-[var(--sig-text-muted)]"
					placeholder="Search commands..."
					bind:value={query}
					onkeydown={handleKeydown}
				/>
				<kbd class="text-[10px] text-[var(--sig-text-muted)]">ESC</kbd>
			</div>
			<div class="max-h-[320px] overflow-y-auto py-2">
				{#if filteredItems.length === 0}
					<div class="px-3 py-6 text-center text-[11px] text-[var(--sig-text-muted)]">
						No results found
					</div>
				{:else}
					{#each filteredItems as item, index}
						<button
							type="button"
							class="w-full flex items-center justify-between px-3 py-2 text-[11px] font-[family-name:var(--font-mono)] text-[var(--sig-text)] hover:bg-[var(--sig-surface)] cursor-pointer {index === selectedIndex ? 'bg-[var(--sig-surface)] text-[var(--sig-text-bright)]' : ''}"
							onclick={() => item.action()}
							onmouseenter={() => selectedIndex = index}
						>
							<span>{item.label}</span>
							{#if item.shortcut}
								<kbd class="text-[9px] text-[var(--sig-text-muted)]">{item.shortcut}</kbd>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
			<div class="flex items-center justify-between border-t border-[var(--sig-border)] px-3 py-2 text-[9px] text-[var(--sig-text-muted)]">
				<span>↑↓ Navigate</span>
				<span>↵ Select</span>
				<span>{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K'} Toggle</span>
			</div>
		</CommandPrimitive.Content>
	</CommandPrimitive.Portal>
</CommandPrimitive.Root>
