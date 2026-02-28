<script lang="ts">
type EmptyStateKind = "installed" | "browse" | "search";

type Action = {
	label: string;
	onClick: () => void;
	variant?: "primary" | "secondary";
};

type Props = {
	kind: EmptyStateKind;
	actions: Action[];
};

let { kind, actions }: Props = $props();

const contentByKind: Record<
	EmptyStateKind,
	{ title: string; description: string }
> = {
	installed: {
		title: "No installed skills yet",
		description: "Browse the catalog and install your first skill.",
	},
	browse: {
		title: "No skills match this browse view",
		description: "Try clearing filters or reload the catalog.",
	},
	search: {
		title: "No search matches",
		description: "Try a broader keyword or browse popular skills.",
	},
};
</script>

<div class="empty-state">
	<p class="empty-title">{contentByKind[kind].title}</p>
	<p class="empty-desc">{contentByKind[kind].description}</p>
	<div class="empty-actions">
		{#each actions as action}
			<button
				type="button"
				class="empty-btn"
				class:primary={action.variant === "primary"}
				onclick={action.onClick}
			>
				{action.label}
			</button>
		{/each}
	</div>
</div>

<style>
	.empty-state {
		padding: var(--space-xl) var(--space-lg);
		margin: var(--space-md) auto;
		max-width: 520px;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 8px;
		border: 1px dashed var(--sig-border-strong);
		background: var(--sig-surface-raised);
	}

	.empty-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 13px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.empty-desc {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text-muted);
	}

	.empty-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
		margin-top: 6px;
	}

	.empty-btn {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 5px 10px;
		border: 1px solid var(--sig-border-strong);
		background: transparent;
		color: var(--sig-text-muted);
		cursor: pointer;
	}

	.empty-btn:hover {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
	}

	.empty-btn.primary {
		border-color: var(--sig-accent);
		background: var(--sig-accent);
		color: var(--sig-bg);
	}
</style>
