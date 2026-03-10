<script lang="ts">
import type { ContinuityEntry, DaemonStatus, Identity } from "$lib/api";
import Cable from "@lucide/svelte/icons/cable";
import Cpu from "@lucide/svelte/icons/cpu";
import Database from "@lucide/svelte/icons/database";

interface Props {
	identity: Identity;
	greeting: string;
	daemonStatus: DaemonStatus | null;
	connectorCount: number;
	continuity: ContinuityEntry[];
	memoryCount: number;
}

const { identity, greeting, daemonStatus, connectorCount, continuity, memoryCount }: Props = $props();

const ageDays = $derived.by(() => {
	const created = daemonStatus?.agentCreatedAt;
	if (!created) return null;
	const ts = new Date(created).getTime();
	if (Number.isNaN(ts)) return null;
	return Math.max(0, Math.floor((Date.now() - ts) / 86_400_000));
});

const ageLabel = $derived.by(() => {
	if (ageDays === null) return null;
	if (ageDays === 0) return "today";
	if (ageDays === 1) return "1 day";
	return `${ageDays} days`;
});

const activeSessions = $derived(daemonStatus?.activeSessions ?? 0);

const latestProject = $derived.by(() => {
	if (continuity.length === 0) return null;
	const sorted = [...continuity].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
	return sorted[0];
});

function formatRecency(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
</script>

<div class="agent-header">
	<div class="header-left">
		<span class="greeting">{greeting}</span>
		<div class="name-row">
			<h1 class="agent-name">{identity.name ?? "Agent"}</h1>
			{#if ageLabel}
				<span class="sig-meta age-label">{ageLabel}</span>
			{/if}
			{#if latestProject}
				<span class="sig-meta project-label">
					{latestProject.project}
					<span class="recency">{formatRecency(latestProject.created_at)}</span>
				</span>
			{/if}
		</div>
	</div>

	<div class="header-right">
		<div class="chip">
			<Database class="chip-icon" />
			<span class="chip-value">{memoryCount.toLocaleString()}</span>
			<span class="chip-label">memories</span>
		</div>
		<div class="chip">
			<Cable class="chip-icon" />
			<span class="chip-value">{connectorCount}</span>
			<span class="chip-label">connectors</span>
		</div>
		<div class="chip">
			<Cpu class="chip-icon" />
			<span class="chip-value">{activeSessions}</span>
			<span class="chip-label">active</span>
		</div>
	</div>
</div>

<style>
	.agent-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		background:
			repeating-conic-gradient(
				rgba(255, 255, 255, 0.02) 0% 25%,
				transparent 0% 50%
			) 0 0 / 10px 10px,
			repeating-conic-gradient(
				transparent 0% 25%,
				rgba(0, 0, 0, 0.03) 0% 50%
			) 5px 5px / 10px 10px,
			repeating-conic-gradient(
				var(--sig-surface) 0% 25%,
				color-mix(in srgb, var(--sig-surface) 96%, black) 0% 50%
			) 0 0 / 10px 10px;
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
	}

	.header-left {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.greeting {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--sig-text-muted);
		text-transform: lowercase;
	}

	.name-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}

	.agent-name {
		font-family: var(--font-display);
		font-size: 18px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-highlight);
		margin: 0;
		line-height: 1.1;
	}

	.age-label {
		color: var(--sig-text-muted);
	}

	.project-label {
		color: var(--sig-accent);
	}

	.recency {
		color: var(--sig-text-muted);
		margin-left: 4px;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		flex-shrink: 0;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: 1rem;
		white-space: nowrap;
	}

	:global(.chip-icon) {
		width: 11px;
		height: 11px;
		color: var(--sig-text-muted);
		flex-shrink: 0;
	}

	.chip-value {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--sig-highlight);
	}

	.chip-label {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
</style>
