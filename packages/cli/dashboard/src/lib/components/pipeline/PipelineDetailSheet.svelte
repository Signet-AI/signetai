<script lang="ts">
	import * as Sheet from "$lib/components/ui/sheet/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { NODE_MAP, type PipelineNodeState, type LogEntry } from "./pipeline-types";
	import { pipeline, selectNode } from "./pipeline-store.svelte";

	let nodeId = $derived(pipeline.selectedNodeId);
	let def = $derived(nodeId ? NODE_MAP.get(nodeId) ?? null : null);
	let state = $derived(nodeId ? pipeline.nodes[nodeId] ?? null : null);
	let open = $derived(nodeId !== null);

	function handleOpenChange(isOpen: boolean) {
		if (!isOpen) selectNode(null);
	}

	function formatTime(ts: string): string {
		try {
			const d = new Date(ts);
			return d.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
		} catch {
			return ts;
		}
	}

	function levelClass(level: string): string {
		switch (level) {
			case "error": return "text-[#e06c75]";
			case "warn": return "text-[#e5c07b]";
			case "debug": return "text-[#6b6b76]";
			default: return "text-[var(--sig-text)]";
		}
	}

	// Queue metrics for display
	let queueMetrics = $derived.by(() => {
		if (!state?.metrics) return null;
		const m = state.metrics as Record<string, unknown>;
		if (m.memory || m.summary) return m;
		if (typeof m.depth === "number") return m;
		return null;
	});
</script>

<Sheet.Root {open} onOpenChange={handleOpenChange}>
	<Sheet.Content side="right" class="w-[380px] bg-[var(--sig-bg)] border-l border-[var(--sig-border)]">
		{#if def && state}
			<Sheet.Header>
				<Sheet.Title class="flex items-center gap-2 font-[family-name:var(--font-display)] text-[var(--sig-text-bright)]">
					{def.label}
					<Badge
						variant="outline"
						class="text-[9px] px-1.5 py-0 font-[family-name:var(--font-mono)]
							{state.health === 'healthy' ? 'border-[#4a7a5e] text-[#4a7a5e]' :
							 state.health === 'degraded' ? 'border-[#b8860b] text-[#b8860b]' :
							 state.health === 'unhealthy' ? 'border-[#8a4a48] text-[#8a4a48]' :
							 'border-[var(--sig-border)] text-[var(--sig-text-muted)]'}"
					>
						{state.health}
					</Badge>
				</Sheet.Title>
				{#if def.description}
					<Sheet.Description class="text-[11px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
						{def.description}
					</Sheet.Description>
				{/if}
			</Sheet.Header>

			<div class="mt-4 space-y-4 overflow-y-auto pr-2" style="max-height: calc(100vh - 140px);">
				<!-- Metrics -->
				<section>
					<h4 class="text-[10px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)] mb-2 font-[family-name:var(--font-display)]">
						Metrics
					</h4>
					<div class="grid grid-cols-3 gap-2">
						<div class="p-2 rounded bg-[var(--sig-surface)] border border-[var(--sig-border)]">
							<div class="text-[9px] text-[var(--sig-text-muted)] uppercase">Score</div>
							<div class="text-[15px] text-[var(--sig-text-bright)] font-[family-name:var(--font-mono)]">
								{state.score > 0 ? (state.score * 100).toFixed(0) + "%" : "--"}
							</div>
						</div>
						<div class="p-2 rounded bg-[var(--sig-surface)] border border-[var(--sig-border)]">
							<div class="text-[9px] text-[var(--sig-text-muted)] uppercase">Queue</div>
							<div class="text-[15px] text-[var(--sig-text-bright)] font-[family-name:var(--font-mono)]">
								{state.queueDepth}
							</div>
						</div>
						<div class="p-2 rounded bg-[var(--sig-surface)] border border-[var(--sig-border)]">
							<div class="text-[9px] text-[var(--sig-text-muted)] uppercase">Errors</div>
							<div class="text-[15px] font-[family-name:var(--font-mono)]"
								class:text-[#8a4a48]={state.errorCount > 0}
								class:text-[var(--sig-text-bright)]={state.errorCount === 0}
							>
								{state.errorCount}
							</div>
						</div>
					</div>
				</section>

				<!-- Queue breakdown (if available) -->
				{#if queueMetrics}
					<section>
						<h4 class="text-[10px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)] mb-2 font-[family-name:var(--font-display)]">
							Queue Details
						</h4>
						<div class="space-y-1 text-[11px] font-[family-name:var(--font-mono)]">
							{#each Object.entries(queueMetrics) as [key, val]}
								{#if typeof val === "object" && val !== null}
									<div class="text-[var(--sig-text-muted)] mt-1">{key}</div>
									{#each Object.entries(val as Record<string, unknown>) as [k, v]}
										<div class="flex justify-between px-2">
											<span class="text-[var(--sig-text-muted)]">{k}</span>
											<span class="text-[var(--sig-text-bright)]">{v}</span>
										</div>
									{/each}
								{:else}
									<div class="flex justify-between">
										<span class="text-[var(--sig-text-muted)]">{key}</span>
										<span class="text-[var(--sig-text-bright)]">{val}</span>
									</div>
								{/if}
							{/each}
						</div>
					</section>
				{/if}

				<!-- Last activity -->
				{#if state.lastActivity}
					<section>
						<h4 class="text-[10px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)] mb-1 font-[family-name:var(--font-display)]">
							Last Activity
						</h4>
						<span class="text-[11px] text-[var(--sig-text)] font-[family-name:var(--font-mono)]">
							{formatTime(state.lastActivity)}
						</span>
					</section>
				{/if}

				<!-- Recent logs -->
				<section>
					<h4 class="text-[10px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)] mb-2 font-[family-name:var(--font-display)]">
						Recent Logs ({state.recentLogs.length})
					</h4>
					<div class="space-y-px max-h-[300px] overflow-y-auto">
						{#each state.recentLogs as log}
							<div class="flex gap-2 py-1 px-1 text-[10px] font-[family-name:var(--font-mono)] hover:bg-[var(--sig-surface-raised)] rounded">
								<span class="text-[var(--sig-text-muted)] shrink-0 w-[52px]">
									{formatTime(log.timestamp)}
								</span>
								<span class="{levelClass(log.level)} shrink-0 w-[34px] uppercase">
									{log.level}
								</span>
								<span class="text-[var(--sig-text)] truncate">
									{log.message}
								</span>
							</div>
						{/each}
						{#if state.recentLogs.length === 0}
							<div class="text-[10px] text-[var(--sig-text-muted)] italic py-2">
								No recent activity
							</div>
						{/if}
					</div>
				</section>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
