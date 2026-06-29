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
let generating = $state(false);
let generationSlow = $state(false);
let generationFailed = $state(false);
let answerText = $state("");
let submittingId = $state<string | null>(null);
let showAnswerId = $state<string | null>(null);
let generationToken = 0;

const reflection = $derived(reflections[0] ?? null);

onMount(() => {
	let active = true;

	async function loadToday(): Promise<void> {
		loading = true;
		const today = await getTodayReflection(agentId);
		if (!active) return;

		const todayItems = today.reflections ?? (today.reflection ? [today.reflection] : []);
		const questions = todayItems.filter((item) => item.question);
		reflections = questions.slice(0, 1);
		loading = false;

		if (questions.length === 0) {
			void generateQuestion();
		}
	}

	void loadToday();

	return () => {
		active = false;
		generationToken += 1;
	};
});

async function generateQuestion(options: { manual?: boolean } = {}): Promise<void> {
	const token = generationToken + 1;
	generationToken = token;
	generating = true;
	generationSlow = false;
	generationFailed = false;

	const slowTimer = setTimeout(() => {
		if (generationToken === token) generationSlow = true;
	}, 10_000);

	try {
		const generated = await generateReflection(agentId, 1);
		if (generationToken !== token) return;
		if (generated.error) {
			generationFailed = reflections.length === 0;
			if (options.manual) toast(generated.error, "error");
			return;
		}
		const next = generated.reflections ?? (generated.reflection ? [generated.reflection] : []);
		const questions = next.filter((item) => item.question);
		if (questions.length > 0) {
			reflections = questions.slice(0, 1);
			answerText = "";
			showAnswerId = null;
			toast(options.manual ? "New question is ready" : "Today's question is ready", "success");
		} else if (options.manual) {
			generationFailed = reflections.length === 0;
			toast("No new question found yet", "info");
		} else {
			generationFailed = true;
		}
	} catch {
		if (generationToken === token) {
			if (options.manual) toast("Couldn't refresh the question", "error");
			else generationFailed = true;
		}
	} finally {
		clearTimeout(slowTimer);
		if (generationToken === token) {
			generating = false;
			generationSlow = false;
		}
	}
}

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
		toast("Saved into your memory thread", "success");
	} else {
		toast(result.error ?? "Failed to save answer", "error");
	}
}
</script>

<div class="panel sig-panel">
	<div class="panel-header sig-panel-header">
		<span class="panel-title">DAILY BRIEF</span>
		<div class="panel-actions">
			{#if reflection}
				<span class="panel-date">{reflection.date}</span>
			{/if}
			<button
				class="refresh-brief"
				disabled={generating || loading || showAnswerId !== null}
				title={showAnswerId ? "Save or cancel your draft before refreshing" : "Generate a new question"}
				onclick={() => generateQuestion({ manual: true })}
			>
				{generating ? "Looking…" : "Refresh"}
			</button>
		</div>
	</div>

	<div class="panel-body">
		{#if loading}
			<div class="loading-state">
				<span class="loading-line"></span>
				<span class="loading-line short"></span>
				<span class="loading-line"></span>
			</div>
		{:else if reflection}
			{#each reflections as item (item.id)}
				<section class="reflection-item" class:reflection-item--question={item.question}>
					{#if item.question}
						<span class="daily-question-label">TODAY'S QUESTION</span>
					{/if}
					<p class="reflection-summary">{item.summary}</p>

					{#if !item.question && item.patterns.length > 0}
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
									disabled={generating}
									onclick={() => {
										answerText = "";
										showAnswerId = item.id;
									}}
								>
									{generating ? "Looking…" : "Write back"}
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
		{:else if generating}
			<div class="brief-status" aria-live="polite">
				<span class="brief-status-label">FINDING TODAY'S QUESTION</span>
				<span class="brief-status-text">
					{generationSlow ? "Still looking. You can keep using the dashboard." : "Looking through recent memories…"}
				</span>
				<div class="loading-state loading-state--ambient">
					<span class="loading-line"></span>
					<span class="loading-line short"></span>
				</div>
			</div>
		{:else if generationFailed}
			<div class="empty-state">
				<span>No good question found yet</span>
				<span class="empty-hint">Daily Brief will try again when there is a stronger memory thread.</span>
			</div>
		{:else}
			<div class="empty-state">
				<span>No brief yet</span>
				<span class="empty-hint">No fresh memory signal found</span>
			</div>
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

	.panel-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.panel-date {
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.refresh-brief {
		font-family: var(--font-body);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-highlight-text);
		background: var(--sig-highlight-muted);
		border: 1px solid var(--sig-highlight-dim);
		border-radius: 999px;
		padding: 3px 8px;
		cursor: pointer;
		text-transform: uppercase;
		transition:
			opacity var(--dur) var(--ease),
			border-color var(--dur) var(--ease),
			background var(--dur) var(--ease);
	}

	.refresh-brief:hover:not(:disabled) {
		background: color-mix(in srgb, var(--sig-highlight) 14%, transparent);
		border-color: var(--sig-highlight);
	}

	.refresh-brief:disabled {
		opacity: 0.55;
		cursor: default;
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

	.reflection-item--question {
		gap: var(--space-md);
		padding: var(--space-sm) 0;
	}

	.daily-question-label {
		font-family: var(--font-display);
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.16em;
		color: var(--sig-highlight);
		text-transform: uppercase;
	}

	.reflection-summary {
		font-family: var(--font-body);
		font-size: 13px;
		line-height: 1.6;
		color: var(--sig-text);
		margin: 0;
	}

	.reflection-item--question .reflection-summary {
		font-size: 13px;
		line-height: 1.6;
		color: var(--sig-text-bright);
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

	.reflection-item--question .question-block {
		border-top: none;
		padding-top: 0;
	}

	.answer-prompt {
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.08em;
		color: var(--primary-foreground);
		background: var(--sig-highlight);
		border: 1px solid var(--sig-highlight);
		padding: 6px 14px;
		border-radius: 999px;
		cursor: pointer;
		align-self: flex-start;
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sig-highlight) 18%, transparent);
		transition:
			opacity var(--dur) var(--ease),
			transform var(--dur) var(--ease),
			box-shadow var(--dur) var(--ease);
	}

	.answer-prompt:hover:not(:disabled) {
		opacity: 0.9;
		transform: translateY(-1px);
		box-shadow: 0 0 18px color-mix(in srgb, var(--sig-highlight) 18%, transparent);
	}

	.answer-prompt:disabled {
		opacity: 0.55;
		cursor: default;
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

	.loading-state--ambient {
		width: min(420px, 100%);
		padding-top: var(--space-sm);
	}

	.brief-status {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: var(--space-sm);
		min-height: 160px;
		padding: var(--space-md) 0;
	}

	.brief-status-label {
		font-family: var(--font-display);
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.16em;
		color: var(--sig-highlight);
		text-transform: uppercase;
	}

	.brief-status-text {
		font-family: var(--font-body);
		font-size: 13px;
		line-height: 1.6;
		color: var(--sig-text-muted);
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
