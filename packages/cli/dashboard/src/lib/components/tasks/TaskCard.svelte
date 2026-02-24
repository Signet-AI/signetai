<script lang="ts">
import type { ScheduledTask } from "$lib/api";
import * as Card from "$lib/components/ui/card/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import Play from "@lucide/svelte/icons/play";

interface Props {
	task: ScheduledTask;
	columnKey: string;
	onclick: () => void;
	ontrigger: () => void;
	ontoggle: (enabled: boolean) => void;
}

let { task, columnKey, onclick, ontrigger, ontoggle }: Props = $props();

function formatRelativeTime(iso: string | null): string {
	if (!iso) return "—";
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

let harnessLabel = $derived(
	task.harness === "claude-code" ? "claude" : "opencode",
);

let nextRunLabel = $derived(formatRelativeTime(task.next_run_at));
let lastRunLabel = $derived(formatRelativeTime(task.last_run_at));
</script>

<button
	class="w-full text-left cursor-pointer bg-transparent border-none p-0"
	onclick={onclick}
>
	<Card.Root
		class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)]
			hover:border-[var(--sig-border-strong)] transition-colors
			{!task.enabled ? 'opacity-50' : ''}"
	>
		<Card.Content class="p-3 space-y-2">
			<div class="flex items-start justify-between gap-2">
				<span
					class="text-[12px] font-medium text-[var(--sig-text-bright)]
						leading-tight line-clamp-2"
				>
					{task.name}
				</span>
				<Badge
					variant="outline"
					class="text-[9px] shrink-0 px-1.5 py-0
						border-[var(--sig-border)]
						text-[var(--sig-text-muted)]"
				>
					{harnessLabel}
				</Badge>
			</div>

			<div
				class="text-[10px] text-[var(--sig-text-muted)]
					font-[family-name:var(--font-mono)]
					flex items-center gap-3"
			>
				<span>{task.cron_expression}</span>
				{#if columnKey === "scheduled"}
					<span>next: {nextRunLabel}</span>
				{:else if columnKey === "running"}
					<span class="text-[var(--sig-warning, #f59e0b)]">running...</span>
				{:else if columnKey === "completed"}
					<span>exit 0 · {lastRunLabel}</span>
				{:else if columnKey === "failed"}
					<span class="text-[var(--sig-error, #ef4444)]">
						exit {task.last_run_exit_code ?? "?"} · {lastRunLabel}
					</span>
				{/if}
			</div>

			<div class="flex items-center justify-between pt-1">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div onclick={(e) => e.stopPropagation()}>
					<Switch
						checked={!!task.enabled}
						onCheckedChange={(v) => ontoggle(v)}
						class="scale-75 origin-left"
					/>
				</div>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div onclick={(e) => e.stopPropagation()}>
					<Button
						variant="ghost"
						size="sm"
						class="h-6 w-6 p-0"
						onclick={ontrigger}
					>
						<Play class="size-3" />
					</Button>
				</div>
			</div>
		</Card.Content>
	</Card.Root>
</button>
