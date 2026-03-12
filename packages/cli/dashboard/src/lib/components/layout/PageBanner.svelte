<script lang="ts">
	import type { Snippet } from "svelte";
	import { useSidebar } from "$lib/components/ui/sidebar/context.svelte.js";

	interface Props {
		title: string;
		children?: Snippet;
		right?: Snippet;
	}

	const { title, children, right }: Props = $props();
	const sidebar = useSidebar();
</script>

<div class="banner">
	<div class="banner-content">
		<div class="banner-left">
			<button
				class="sidebar-toggle"
				onclick={() => sidebar.toggle()}
				aria-label="Toggle sidebar"
			>
				<span
					class="sidebar-toggle-icon"
					aria-hidden="true"
				></span>
			</button>
			{#if children}
				{@render children()}
			{/if}
		</div>
		<div class="banner-text">
			<h2 class="banner-title">{title}</h2>
		</div>
		<div class="banner-right">
			{#if right}
				{@render right()}
			{/if}
		</div>
	</div>
	<!-- Coordinate markers -->
	<span class="banner-coord banner-coord--tl" aria-hidden="true">0,0</span>
	<span class="banner-coord banner-coord--br" aria-hidden="true">■</span>
</div>

<style>
	.banner {
		position: relative;
		display: flex;
		align-items: center;
		min-height: 32px;
		padding: 6px var(--space-md);
		overflow: hidden;
		background: var(--sig-surface);
		margin-bottom: 2rem;
	}

	/* Content layout — grid keeps side slots in flow to prevent overlap */
	.banner-content {
		position: relative;
		z-index: 1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		width: 100%;
		gap: var(--space-md);
	}

	.banner-text {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.banner-title {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.2em;
		color: var(--sig-text-bright);
		margin: 0;
		line-height: 1.2;
	}

	.banner-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-width: 0;
		justify-self: start;
	}

	.banner-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-width: 0;
		justify-self: end;
	}

	/* Coordinate markers — tiny data labels at corners */
	.banner-coord {
		position: absolute;
		font-family: var(--font-mono);
		font-size: 7px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		opacity: 0.4;
		pointer-events: none;
		z-index: 1;
	}

	.banner-coord--tl {
		top: 4px;
		left: 8px;
	}

	.banner-coord--br {
		bottom: 4px;
		right: 8px;
	}

	.sidebar-toggle {
		display: none;
		align-items: center;
		justify-content: center;
		height: 26px;
		width: 26px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 4px;
		background: transparent;
		cursor: pointer;
		flex-shrink: 0;
		transition: border-color var(--dur) var(--ease);
	}

	@media (max-width: 1023px) {
		.sidebar-toggle {
			display: flex;
			position: fixed;
			top: 6px;
			left: var(--space-sm, 8px);
			z-index: 50;
		}
	}

	.sidebar-toggle:hover {
		border-color: var(--sig-accent);
	}

	.sidebar-toggle-icon {
		position: relative;
		display: inline-block;
		height: 10px;
		width: 10px;
	}

	.sidebar-toggle-icon::before {
		content: "";
		position: absolute;
		width: 1px;
		height: 100%;
		left: 50%;
		background: var(--sig-highlight);
	}

	.sidebar-toggle-icon::after {
		content: "";
		position: absolute;
		width: 100%;
		height: 1px;
		top: 50%;
		background: var(--sig-highlight);
	}

	@media (max-width: 1023px) {
		.banner {
			padding: 6px var(--space-sm);
			margin-bottom: 0.75rem;
		}

		.banner-content {
			grid-template-columns: 1fr;
			justify-items: center;
			gap: 0.25rem;
		}

		.banner-text {
			margin-top: 2rem;
		}

		.banner-left {
			justify-self: center;
			flex-wrap: wrap;
			justify-content: center;
		}

		.banner-right {
			justify-self: center;
		}

		.banner-title {
			font-size: 12px;
		}
	}
</style>
