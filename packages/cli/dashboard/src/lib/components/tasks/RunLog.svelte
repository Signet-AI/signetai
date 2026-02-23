<script lang="ts">
import type { TaskRun } from "$lib/api";
import * as Card from "$lib/components/ui/card/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";

interface Props {
	run: TaskRun;
}

let { run }: Props = $props();

let expanded = $state(false);

function formatDate(iso: string | null): string {
	if (!iso) return "—";
	return new Date(iso).toLocaleString();
}

function formatDuration(start: string, end: string | null): string {
	if (!end) return "running...";
	const ms = new Date(end).getTime() - new Date(start).getTime();
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m ${s}s`;
}

const statusColors: Record<string, string> = {
	pending: "var(--sig-text-muted)",
	running: "var(--sig-warning, #f59e0b)",
	completed: "var(--sig-success)",
	failed: "var(--sig-error, #ef4444)",
};
</script>

<button
	class="w-full text-left cursor-pointer bg-transparent border-none p-0"
	onclick={() => { expanded = !expanded; }}
>
	<Card.Root
		class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)]
			hover:border-[var(--sig-border-strong)] transition-colors"
	>
		<Card.Content class="p-2.5 space-y-1.5">
			<div class="flex items-center justify-between gap-2">
				<div class="flex items-center gap-2">
					<span
						class="inline-block w-1.5 h-1.5"
						style="background: {statusColors[run.status] ?? statusColors.pending}"
					></span>
					<Badge
						variant="outline"
						class="text-[9px] px-1.5 py-0
							border-[var(--sig-border)]"
						style="color: {statusColors[run.status] ?? statusColors.pending}"
					>
						{run.status}
					</Badge>
					{#if run.exit_code !== null}
						<span
							class="text-[10px] font-[family-name:var(--font-mono)]
								text-[var(--sig-text-muted)]"
						>
							exit {run.exit_code}
						</span>
					{/if}
				</div>
				<span
					class="text-[10px] font-[family-name:var(--font-mono)]
						text-[var(--sig-text-muted)]"
				>
					{formatDuration(run.started_at, run.completed_at)}
				</span>
			</div>

			<div class="text-[10px] text-[var(--sig-text-muted)]
				font-[family-name:var(--font-mono)]">
				{formatDate(run.started_at)}
			</div>

			{#if expanded}
				{#if run.error}
					<div class="mt-2">
						<span
							class="text-[9px] font-bold uppercase tracking-[0.08em]
								text-[var(--sig-error, #ef4444)]"
						>
							Error
						</span>
						<pre
							class="mt-1 p-2 text-[10px] leading-[1.5]
								bg-[var(--sig-surface)] border border-[var(--sig-border)]
								rounded overflow-x-auto whitespace-pre-wrap
								text-[var(--sig-error, #ef4444)]
								font-[family-name:var(--font-mono)]
								max-h-[120px] overflow-y-auto"
						>{run.error}</pre>
					</div>
				{/if}
				{#if run.stdout}
					<div class="mt-2">
						<span
							class="text-[9px] font-bold uppercase tracking-[0.08em]
								text-[var(--sig-text-muted)]"
						>
							stdout
						</span>
						<pre
							class="mt-1 p-2 text-[10px] leading-[1.5]
								bg-[var(--sig-surface)] border border-[var(--sig-border)]
								rounded overflow-x-auto whitespace-pre-wrap
								text-[var(--sig-text)]
								font-[family-name:var(--font-mono)]
								max-h-[200px] overflow-y-auto"
						>{run.stdout}</pre>
					</div>
				{/if}
				{#if run.stderr}
					<div class="mt-2">
						<span
							class="text-[9px] font-bold uppercase tracking-[0.08em]
								text-[var(--sig-text-muted)]"
						>
							stderr
						</span>
						<pre
							class="mt-1 p-2 text-[10px] leading-[1.5]
								bg-[var(--sig-surface)] border border-[var(--sig-border)]
								rounded overflow-x-auto whitespace-pre-wrap
								text-[var(--sig-warning, #f59e0b)]
								font-[family-name:var(--font-mono)]
								max-h-[200px] overflow-y-auto"
						>{run.stderr}</pre>
					</div>
				{/if}
				{#if !run.error && !run.stdout && !run.stderr}
					<span class="text-[10px] text-[var(--sig-text-muted)] mt-2 block">
						No output captured
					</span>
				{/if}
			{:else if run.stdout || run.stderr || run.error}
				<span class="text-[10px] text-[var(--sig-accent)] mt-0.5 block">
					Click to expand output
				</span>
			{/if}
		</Card.Content>
	</Card.Root>
</button>
