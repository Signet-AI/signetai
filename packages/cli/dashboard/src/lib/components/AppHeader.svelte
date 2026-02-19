<script lang="ts">
	import type { DaemonStatus } from "$lib/api";

	interface Props {
		memCount: number;
		harnessCount: number;
		daemonStatus: DaemonStatus | null;
		theme: "dark" | "light";
		onthemetoggle: () => void;
	}

	let { memCount, harnessCount, daemonStatus, theme, onthemetoggle }: Props = $props();
</script>

<header class="header">
	<div class="brand">
		<div class="brand-crosshair" aria-hidden="true"></div>
		<span class="brand-name">SIGNET</span>
		<span class="brand-sep" aria-hidden="true">//</span>
		<span class="brand-sub">AGENT CONTROL</span>
	</div>

	<div class="header-center" aria-hidden="true">
		<span class="header-stat">{memCount} MEM</span>
		<span class="header-divider">·</span>
		<span class="header-stat">{harnessCount} HARNESS</span>
		<span class="header-divider">·</span>
		<span class="header-stat">v{daemonStatus?.version ?? '—'}</span>
	</div>

	<div class="header-right">
		<div class="daemon-status">
			<span class="daemon-dot" class:daemon-dot-live={!!daemonStatus}></span>
			<span class="daemon-label">{daemonStatus ? 'ONLINE' : 'OFFLINE'}</span>
		</div>
		<button class="btn-icon" onclick={onthemetoggle} aria-label="Toggle theme">
			{#if theme === 'dark'}
				<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
					<circle cx="7" cy="7" r="3"/>
					<path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.05 3.05l1.06 1.06M9.9 9.9l1.06 1.06M3.05 10.95l1.06-1.06M9.9 4.1l1.06-1.06"/>
				</svg>
			{:else}
				<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
					<path d="M12 7.5a5 5 0 11-6.5-6.5 5 5 0 006.5 6.5z"/>
				</svg>
			{/if}
		</button>
	</div>
</header>
