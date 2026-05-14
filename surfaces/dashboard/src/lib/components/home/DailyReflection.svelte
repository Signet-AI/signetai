<script lang="ts">
import type { DailyReflection } from "$lib/api";
import { answerReflection, generateReflection, getTodayReflection } from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";
import { onMount } from "svelte";

interface Props {
	agentId: string;
}

const { agentId }: Props = $props();

let reflections = $state<DailyReflection[]>([]);
let loading = $state(true);
let answerText = $state("");
let submittingId = $state<string | null>(null);
let showAnswerId = $state<string | null>(null);

const reflection = $derived(reflections[0] ?? null);

onMount(async () => {
	loading = true;
	const generated = await generateReflection(agentId, 3);
	let next = generated.reflections ?? (generated.reflection ? [generated.reflection] : []);

	if (next.length === 0) {
		const today = await getTodayReflection(agentId);
		next = today.reflections ?? (today.reflection ? [today.reflection] : []);
	}

	reflections = next;
	loading = false;
});

async function handleAnswer(item: DailyReflection): Promise<void> {
	if (!answerText.trim()) return;
	submittingId = item.id;
	const result = await answerReflection(item.id, answerText, agentId);
	submittingId = null;
	if (result.success) {
		reflections = reflections.map((reflection) =>
			reflection.id === item.id
				? { ...reflection, answer: answerText, answerMemoryId: result.memoryId ?? null }
				: reflection,
		);
		answerText = "";
		showAnswerId = null;
		toast("Answer saved as memory", "success");
	} else {
		toast(result.error ?? "Failed to save answer", "error");
	}
}
</script>

<div class="panel sig-panel">
	<div class="panel-header sig-panel-header">
		<span class="panel-title">DAILY BRIEF</span>
		{#if reflection}
			<span class="panel-date">{reflection.date}</span>
		{/if}
	</div>

	<div class="panel-body">
		{#if loading}
			<div class="loading-state">
				<span class="loading-line"></span>
				<span class="loading-line short"></span>
				<span class="loading-line"></span>
			</div>
		{:else if reflections.length === 0}
			<div class="empty-state">
				<span>No brief yet</span>
				<span class="empty-hint">No fresh memory signal found</span>
			</div>
		{:else}
			{#each reflections as item (item.id)}
				<section class="reflection-item">
					<p class="reflection-summary">{item.summary}</p>

					{#if item.patterns.length > 0}
						<div class="patterns">
							{#each item.patterns as pattern}
								<span class="pattern-tag">{pattern}</span>
							{/each}
						</div>
					{/if}

					{#if item.question && !item.answer}
						<div class="question-block">
							{#if showAnswerId === item.id}
								<textarea
									class="answer-input"
									placeholder="Type your reflection..."
									bind:value={answerText}
									rows="2"
								></textarea>
								<div class="answer-actions">
									<button
										class="answer-submit"
										disabled={!answerText.trim() || submittingId === item.id}
										onclick={() => handleAnswer(item)}
									>
										{submittingId === item.id ? "Saving..." : "Save"}
									</button>
									<button class="answer-cancel" onclick={() => (showAnswerId = null)}>
										Cancel
									</button>
								</div>
							{:else}
								<button
									class="answer-prompt"
									onclick={() => {
										answerText = "";
										showAnswerId = item.id;
									}}
								>
									Answer
								</button>
							{/if}
						</div>
					{/if}

					{#if item.answer}
						<div class="answered-block">
							<span class="answered-label">YOUR ANSWER</span>
							<p class="answered-text">{item.answer}</p>
						</div>
					{/if}
				</section>
			{/each}
		{/if}
	</div>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--sig-surface);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.panel-date {
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-sm) var(--space-md);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.reflection-item {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		border-top: 1px solid var(--sig-border);
		padding-top: var(--space-sm);
	}

	.reflection-item:first-child {
		border-top: none;
		padding-top: 0;
	}

	.reflection-summary {
		font-family: var(--font-body);
		font-size: 13px;
		line-height: 1.6;
		color: var(--sig-text);
		margin: 0;
	}

	.patterns {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.pattern-tag {
		font-family: var(--font-body);
		font-size: 9px;
		padding: 1px 6px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 2px;
		color: var(--sig-highlight);
		letter-spacing: 0.04em;
	}

	.question-block {
		display: flex;
		flex-direction: column;
		gap: 6px;
		border-top: 1px solid var(--sig-border);
		padding-top: var(--space-sm);
	}

	.answer-prompt {
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.06em;
		color: var(--sig-surface);
		background: var(--sig-accent);
		border: none;
		padding: 4px 12px;
		border-radius: 2px;
		cursor: pointer;
		align-self: flex-start;
		transition: opacity var(--dur) var(--ease);
	}

	.answer-prompt:hover {
		opacity: 0.8;
	}

	.answer-input {
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: 2px;
		padding: 6px 8px;
		resize: none;
		outline: none;
		width: 100%;
	}

	.answer-input:focus {
		border-color: var(--sig-border-strong);
	}

	.answer-actions {
		display: flex;
		gap: 8px;
	}

	.answer-submit {
		font-family: var(--font-body);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-accent);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		transition: color var(--dur) var(--ease);
	}

	.answer-submit:hover:not(:disabled) {
		color: var(--sig-highlight-text);
	}

	.answer-submit:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.answer-cancel {
		font-family: var(--font-body);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}

	.answered-block {
		border-top: 1px solid var(--sig-border);
		padding-top: var(--space-sm);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.answered-label {
		font-family: var(--font-display);
		font-size: 8px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-success);
	}

	.answered-text {
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text);
		margin: 0;
	}

	.empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		font-family: var(--font-body);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		text-align: center;
	}

	.empty-hint {
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 4px;
	}

	.loading-line {
		height: 10px;
		background: var(--sig-surface-raised);
		border-radius: 2px;
		opacity: 0.5;
		animation: pulse 1.5s ease-in-out infinite;
	}

	.loading-line.short {
		width: 60%;
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 0.5;
		}
		50% {
			opacity: 0.2;
		}
	}
</style>
