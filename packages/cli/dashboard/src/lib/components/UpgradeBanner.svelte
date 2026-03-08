<script lang="ts">
	import { browser } from "$app/environment";
	import type { DaemonStatus } from "$lib/api";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import X from "@lucide/svelte/icons/x";

	const STORAGE_KEY_PREFIX = "signet-upgrade-banner-dismissed-";

	interface Props {
		daemonStatus: DaemonStatus | null;
	}

	let { daemonStatus }: Props = $props();

	let dismissed = $state(false);

	const version = $derived(daemonStatus?.version ?? null);
	const storageKey = $derived(version ? `${STORAGE_KEY_PREFIX}${version}` : null);

	// Check if this version's banner was already dismissed
	if (browser && storageKey) {
		dismissed = localStorage.getItem(storageKey) === "true";
	}

	// Show banner when version is known and not dismissed for this version
	const visible = $derived(
		!!version && version !== "0.0.0" && !dismissed,
	);

	function dismiss() {
		dismissed = true;
		if (browser && storageKey) {
			localStorage.setItem(storageKey, "true");
		}
	}
</script>

{#if visible}
	<div
		class="flex items-center justify-between gap-3 px-4 py-2
			border-b border-[var(--sig-border)]
			bg-[var(--sig-surface-raised)]"
	>
		<div class="flex items-center gap-3 min-w-0">
			<span
				class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em]
					text-[var(--sig-accent)]
					font-[family-name:var(--font-display)]
					shrink-0"
			>
				<Sparkles class="size-3" />
				v{version}
			</span>
			<span
				class="text-[12px] text-[var(--sig-text)]
					font-[family-name:var(--font-mono)]
					truncate"
			>
				Knowledge graph, session continuity, constellation entity overlay
			</span>
		</div>
		<div class="flex items-center gap-2 shrink-0">
			<button
				onclick={dismiss}
				class="flex items-center justify-center size-6
					text-[var(--sig-text-muted)]
					hover:text-[var(--sig-text-bright)]
					bg-transparent border-none cursor-pointer
					transition-colors duration-200"
				aria-label="Dismiss upgrade banner"
			>
				<X class="size-3.5" />
			</button>
		</div>
	</div>
{/if}
