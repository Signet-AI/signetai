<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		title: string;
		children?: Snippet;
		right?: Snippet;
	}

	const { title, children, right }: Props = $props();
</script>

<div class="banner">
	<div class="banner-content">
		<div class="banner-left">
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
		background: transparent;
		margin-bottom: var(--space-sm);
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

	.banner-coord--br {
		bottom: 4px;
		right: 8px;
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

		.banner-left {
			justify-self: center;
			flex-wrap: wrap;
			justify-content: center;
		}

		:global(:has(.mobile-sidebar-trigger)) .banner-left {
			padding-left: 4.5rem; /* clear fixed sidebar trigger */
			padding-right: 4.5rem; /* symmetric balance */
		}

		.banner-right {
			justify-self: center;
		}

		.banner-text {
			margin: 0.75rem 0 0;
		}

		.banner-title {
			font-size: 12px;
		}
	}
</style>
