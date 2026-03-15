<script lang="ts">
	import { os, type AppTrayEntry } from "$lib/stores/os.svelte";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";

	// Apps that have menuItems declared in their manifest
	const menuApps = $derived(
		os.entries.filter(
			(e) => e.manifest?.menuItems && e.manifest.menuItems.length > 0,
		),
	);

	// Track which dropdown is open (null = none)
	let openMenuId = $state<string | null>(null);

	function toggleMenu(appId: string): void {
		openMenuId = openMenuId === appId ? null : appId;
	}

	function handleMenuItemClick(_appId: string, _item: string): void {
		// Menu actions are not yet implemented — items are rendered disabled
		openMenuId = null;
	}

	function handleClickOutside(): void {
		openMenuId = null;
	}

	function getAppIcon(app: AppTrayEntry): string {
		return app.manifest?.icon ?? app.autoCard?.name?.charAt(0) ?? "▪";
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
{#if menuApps.length > 0}
	<div class="menu-bar" onclick={handleClickOutside}>
		{#each menuApps as app (app.id)}
			{@const isOpen = openMenuId === app.id}
			<div class="menu-item-wrapper">
				<button
					class="menu-trigger"
					class:menu-trigger--active={isOpen}
					onclick={(e) => { e.stopPropagation(); toggleMenu(app.id); }}
				>
					<span class="menu-app-name">{app.manifest?.name ?? app.name}</span>
					<ChevronDown class="size-3 menu-chevron {isOpen ? 'rotated' : ''}" />
				</button>

				{#if isOpen && app.manifest?.menuItems}
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
					<div class="menu-dropdown" onclick={(e) => e.stopPropagation()}>
						{#each app.manifest.menuItems as item}
							<button
								class="menu-dropdown-item menu-dropdown-item--disabled"
								disabled
								title="Coming soon"
							>
								{item}
								<span class="menu-coming-soon">Coming soon</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.menu-bar {
		display: flex;
		align-items: center;
		gap: 0;
		padding: 0 var(--space-md);
		height: 28px;
		min-height: 28px;
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-surface);
		font-family: var(--font-mono);
		font-size: 11px;
		overflow-x: auto;
		overflow-y: visible;
		position: relative;
		z-index: 50;
	}

	.menu-item-wrapper {
		position: relative;
	}

	.menu-trigger {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 3px 8px;
		background: none;
		border: none;
		color: var(--sig-text);
		font-family: var(--font-mono);
		font-size: 11px;
		cursor: pointer;
		border-radius: 3px;
		white-space: nowrap;
		transition: background 0.1s ease;
	}

	.menu-trigger:hover {
		background: var(--sig-border);
	}

	.menu-trigger--active {
		background: var(--sig-border-strong);
		color: var(--sig-text-bright);
	}

	.menu-app-name {
		letter-spacing: 0.02em;
	}

	.menu-trigger :global(.menu-chevron) {
		opacity: 0.5;
		transition: transform 0.15s ease;
	}

	.menu-trigger :global(.rotated) {
		transform: rotate(180deg);
	}

	.menu-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		min-width: 160px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--radius);
		padding: 4px 0;
		z-index: 100;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
	}

	.menu-dropdown-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 5px 12px;
		background: none;
		border: none;
		color: var(--sig-text);
		font-family: var(--font-mono);
		font-size: 11px;
		cursor: pointer;
		white-space: nowrap;
	}

	.menu-dropdown-item:hover:not(:disabled) {
		background: var(--sig-border);
		color: var(--sig-text-bright);
	}

	.menu-dropdown-item--disabled {
		opacity: 0.5;
		cursor: not-allowed;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.menu-coming-soon {
		font-size: 9px;
		opacity: 0.6;
		font-style: italic;
	}
</style>
