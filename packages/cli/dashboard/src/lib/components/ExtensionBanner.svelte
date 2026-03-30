<script lang="ts">
import { browser } from "$app/environment";
import Chrome from "@lucide/svelte/icons/chrome";
import Globe from "@lucide/svelte/icons/globe";
import X from "@lucide/svelte/icons/x";

const STORAGE_KEY = "signet-extension-banner-dismissed";
const EXTENSION_MARKER = "signetExtension";

let dismissed = $state(false);
let extensionInstalled = $state(false);

if (browser) {
	dismissed = localStorage.getItem(STORAGE_KEY) === "true";
	extensionInstalled = document.documentElement.dataset[EXTENSION_MARKER] === "true";
}

const visible = $derived(!dismissed && !extensionInstalled);

function dismiss() {
	dismissed = true;
	if (browser) {
		localStorage.setItem(STORAGE_KEY, "true");
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
				class="text-[10px] font-bold uppercase tracking-[0.08em]
					text-[var(--sig-accent)]
					font-[family-name:var(--font-display)]
					shrink-0"
			>
				New
			</span>
			<span
				class="text-[12px] text-[var(--sig-text)]
					font-[family-name:var(--font-mono)]
					truncate"
			>
				Browser extension — quick memory access from any tab
			</span>
		</div>
		<div class="flex items-center gap-2 shrink-0">
			<a
				href="https://github.com/Signet-AI/signetai/tree/main/packages/extension#install"
				target="_blank"
				rel="noopener noreferrer"
				class="flex items-center gap-1.5 px-2 py-1
					text-[10px] uppercase tracking-[0.06em]
					text-[var(--sig-text-bright)]
					bg-[var(--sig-surface)] border border-[var(--sig-border-strong)]
					hover:bg-[var(--sig-accent)] hover:text-[var(--sig-bg)]
					transition-all duration-200
					font-[family-name:var(--font-mono)]
					no-underline cursor-pointer"
			>
				Install
			</a>
			<button
				onclick={dismiss}
				class="flex items-center justify-center size-6
					text-[var(--sig-text-muted)]
					hover:text-[var(--sig-text-bright)]
					bg-transparent border-none cursor-pointer
					transition-colors duration-200"
				aria-label="Dismiss extension banner"
			>
				<X class="size-3.5" />
			</button>
		</div>
	</div>
{/if}
