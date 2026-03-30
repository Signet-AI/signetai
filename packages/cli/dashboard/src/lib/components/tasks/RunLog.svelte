<script lang="ts">
import type { TaskRun } from "$lib/api";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import { tick } from "svelte";

interface Props {
	run: TaskRun;
}

let { run }: Props = $props();

let expanded = $state(false);
let termRef: HTMLDivElement | undefined = $state(undefined);

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

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ANSI_COLORS: Record<string, string> = {
	"31": "var(--sig-error, #ef4444)",
	"32": "var(--sig-success)",
	"33": "var(--sig-warning, #e8a832)",
	"90": "var(--sig-text-muted)",
	"36": "var(--sig-accent)",
	"34": "var(--sig-highlight)",
	"35": "var(--sig-accent)",
};

// INVARIANT: escapeHtml must run on the raw input before any HTML tags are
// inserted. {@html} in the template relies on this — any future change that
// interpolates user-controlled content into replacement strings will introduce XSS.
function ansiToHtml(text: string): string {
	let result = escapeHtml(text);
	// Match compound CSI sequences like \x1b[1;31m as well as simple \x1b[31m.
	// For compound codes, prefer the last numeric segment as the color code and
	// apply bold when "1" is present.
	result = result.replace(/\x1b\[(\d+(?:;\d+)*)m([\s\S]*?)\x1b\[0m/g, (_, codes, content) => {
		const parts = codes.split(";");
		const bold = parts.includes("1");
		const color = parts.map((c: string) => ANSI_COLORS[c]).find(Boolean);
		let out = content;
		if (color) out = `<span style="color:${color}">${out}</span>`;
		if (bold) out = `<strong>${out}</strong>`;
		return out;
	});
	// Strip any remaining CSI sequences (including compound ones) that weren't
	// wrapped above (e.g. codes with no matching reset).
	return result.replace(/\x1b\[\d+(?:;\d+)*m/g, "");
}

function toLines(text: string | null): string[] {
	if (!text) return [];
	return text.split("\n");
}

async function scrollToBottom(): Promise<void> {
	await tick();
	termRef?.scrollTo({ top: termRef.scrollHeight, behavior: "smooth" });
}

$effect(() => {
	if (expanded && (run.stdout || run.stderr || run.error)) {
		void scrollToBottom();
	}
});
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
						class="text-[9px] px-1.5 py-0 border-[var(--sig-border)]"
						style="color: {statusColors[run.status] ?? statusColors.pending}"
					>
						{run.status}
					</Badge>
					{#if run.exit_code !== null}
						<span class="text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
							exit {run.exit_code}
						</span>
					{/if}
				</div>
				<span class="text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)]">
					{formatDuration(run.started_at, run.completed_at)}
				</span>
			</div>

			<div class="text-[10px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
				{formatDate(run.started_at)}
			</div>

			{#if expanded}
				{@const stdoutLines = toLines(run.stdout)}
				{@const stderrLines = toLines(run.stderr)}
				{@const hasOutput = run.error || stdoutLines.length > 0 || stderrLines.length > 0}

				{#if !hasOutput}
					<span class="text-[10px] text-[var(--sig-text-muted)] mt-2 block">
						No output captured
					</span>
				{:else}
					<div
						bind:this={termRef}
						class="mt-2 bg-[var(--sig-bg)] border border-[var(--sig-border)]
							rounded max-h-[280px] overflow-y-auto
							font-[family-name:var(--font-mono)] text-[10px] leading-[1.55]
							text-[var(--sig-text)] p-2.5"
						role="log"
					>
						{#if run.error}
							<div class="text-[var(--sig-error,#ef4444)] mb-1">
								error: {run.error}
							</div>
						{/if}
						{#if stderrLines.length > 0}
							{#each stderrLines as line, i (i)}
								<div class="whitespace-pre-wrap break-words min-h-[1em] text-[var(--sig-warning,#e8a832)]">
									{@html ansiToHtml(line) || "&nbsp;"}
								</div>
							{/each}
						{/if}
						{#if stdoutLines.length > 0}
							{#each stdoutLines as line, i (i)}
								<div class="whitespace-pre-wrap break-words min-h-[1em]">
									{@html ansiToHtml(line) || "&nbsp;"}
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			{:else if run.stdout || run.stderr || run.error}
				<span class="text-[10px] text-[var(--sig-accent)] mt-0.5 block">
					Click to expand output
				</span>
			{/if}
		</Card.Content>
	</Card.Root>
</button>
