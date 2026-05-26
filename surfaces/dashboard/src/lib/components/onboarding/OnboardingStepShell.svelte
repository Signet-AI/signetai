<script lang="ts">
	interface Props {
		readonly stepNumber: string;
		readonly title: string;
		readonly subtitle: string;
		readonly children: import("svelte").Snippet;
	}

	const { stepNumber, title, subtitle, children }: Props = $props();
</script>

<div class="step-shell">
	<div class="step-shell-head">
		<span class="step-shell-number">{stepNumber}</span>
		<div>
			<h3 class="step-shell-title">{title}</h3>
			<p class="step-shell-subtitle">{subtitle}</p>
		</div>
	</div>
	<div class="step-shell-body">
		{@render children()}
	</div>
</div>

<style>
	.step-shell {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.step-shell-head {
		display: flex;
		gap: 12px;
		align-items: flex-start;
	}

	.step-shell-number {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		color: var(--sig-text-bright);
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
		flex: 0 0 auto;
	}

	.step-shell-title {
		margin: 0;
		font-family: var(--font-display, monospace);
		font-size: 14px;
		letter-spacing: 0.09em;
		color: var(--sig-text-bright);
		text-transform: uppercase;
	}

	.step-shell-subtitle {
		margin: 4px 0 0;
		font-size: 12px;
		line-height: 1.35;
		color: var(--sig-text-muted);
	}

	.step-shell-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
