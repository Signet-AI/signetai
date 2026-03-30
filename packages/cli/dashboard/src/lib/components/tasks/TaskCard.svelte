<script lang="ts">
import type { ScheduledTask } from "$lib/api";
import { Switch } from "$lib/components/ui/switch/index.js";
import Play from "@lucide/svelte/icons/play";

interface Props {
	task: ScheduledTask;
	columnKey: string;
	isSelected?: boolean;
	onclick: () => void;
	ontrigger: () => void;
	ontoggle: (enabled: boolean) => void;
}

let { task, columnKey, isSelected = false, onclick, ontrigger, ontoggle }: Props = $props();

function formatRelativeTime(iso: string | null): string {
	if (!iso) return "--";
	const diff = new Date(iso).getTime() - Date.now();
	const absDiff = Math.abs(diff);
	if (absDiff < 60_000) return diff > 0 ? "< 1m" : "just now";
	if (absDiff < 3_600_000) {
		const m = Math.round(absDiff / 60_000);
		return diff > 0 ? `${m}m` : `${m}m ago`;
	}
	if (absDiff < 86_400_000) {
		const h = Math.round(absDiff / 3_600_000);
		return diff > 0 ? `${h}h` : `${h}h ago`;
	}
	const d = Math.round(absDiff / 86_400_000);
	return diff > 0 ? `${d}d` : `${d}d ago`;
}

const harnessLabel = $derived(
	task.harness === "claude-code" ? "claude" : task.harness === "codex" ? "codex" : "opencode",
);

const nextRunLabel = $derived(formatRelativeTime(task.next_run_at));
const lastRunLabel = $derived(formatRelativeTime(task.last_run_at));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="task-card"
	class:task-card--selected={isSelected}
	class:task-card--disabled={!task.enabled}
	onclick={onclick}
	onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(); } }}
	tabindex="0"
	role="button"
	data-task-id={task.id}
	data-column={columnKey}
>
	<div class="task-top">
		<span class="task-name">{task.name}</span>
		<span class="task-harness">{harnessLabel}</span>
	</div>

	<div class="task-meta">
		<span>{task.cron_expression}</span>
		{#if columnKey === "scheduled"}
			<span>next: {nextRunLabel}</span>
		{:else if columnKey === "running"}
			<span class="task-status-running">running</span>
		{:else if columnKey === "completed"}
			<span>exit 0 · {lastRunLabel}</span>
		{:else if columnKey === "failed"}
			<span class="task-status-failed">
				exit {task.last_run_exit_code ?? "?"} · {lastRunLabel}
			</span>
		{/if}
	</div>

	<div class="task-actions">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div onclick={(e: MouseEvent) => e.stopPropagation()}>
			<Switch
				checked={!!task.enabled}
				onCheckedChange={(v: unknown) => ontoggle(v === true)}
				class="scale-75 origin-left"
			/>
		</div>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<button
			class="trigger-btn"
			onclick={(e: MouseEvent) => { e.stopPropagation(); ontrigger(); }}
		>
			<Play class="size-3" />
		</button>
	</div>
</div>

<style>
	.task-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: var(--space-sm) var(--space-md);
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--sig-border);
		text-align: left;
		cursor: pointer;
		outline: none;
		transition: background var(--dur) var(--ease);
		width: 100%;
	}

	.task-card:last-child {
		border-bottom: none;
	}

	.task-card:hover {
		background: var(--sig-surface-raised);
	}

	.task-card--selected {
		background: var(--sig-surface-raised);
		border-left: 2px solid var(--sig-highlight);
	}

	.task-card:focus-visible {
		background: var(--sig-surface-raised);
		border-left: 2px solid var(--sig-highlight);
	}

	.task-card--disabled {
		opacity: 0.4;
	}

	.task-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.task-name {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.task-harness {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		padding: 1px 5px;
		border: 1px solid var(--sig-border);
		border-radius: 2px;
		flex-shrink: 0;
	}

	.task-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
	}

	.task-status-running {
		color: var(--sig-warning);
	}

	.task-status-failed {
		color: var(--sig-danger);
	}

	.task-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-top: 2px;
	}

	.trigger-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		background: none;
		border: none;
		color: var(--sig-text-muted);
		cursor: pointer;
		border-radius: 2px;
		transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.trigger-btn:hover {
		color: var(--sig-highlight);
		background: var(--sig-surface-raised);
	}
</style>
