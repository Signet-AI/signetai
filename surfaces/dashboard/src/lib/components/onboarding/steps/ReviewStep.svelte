<script lang="ts">
	import {
		EMBEDDING_PROVIDER_OPTIONS,
		EXTRACTION_PROVIDER_OPTIONS,
		IDENTITY_PRESET_META,
		type OnboardingState,
	} from "../onboarding-state.svelte";

	interface Props {
		state: OnboardingState;
	}

	const { state }: Props = $props();

	const presetLabel = $derived(IDENTITY_PRESET_META.find((p) => p.name === state.identityPreset)?.title ?? state.identityPreset);
	const embeddingLabel = $derived(
		EMBEDDING_PROVIDER_OPTIONS.find((o) => o.value === state.embeddingProvider)?.label ??
			state.embeddingProvider,
	);
	const extractionLabel = $derived(
		EXTRACTION_PROVIDER_OPTIONS.find((o) => o.value === state.extractionProvider)?.label ??
			state.extractionProvider,
	);
</script>

<div class="review-grid">
	<section class="review-section">
		<span class="review-label">Identity preset</span>
		<span class="review-value review-badge">{presetLabel}</span>
	</section>

	<section class="review-section">
		<span class="review-label">Agent name</span>
		<span class="review-value">{state.agentName}</span>
	</section>

	<section class="review-section">
		<span class="review-label">Description</span>
		<span class="review-value">{state.agentDescription}</span>
	</section>

	<section class="review-section">
		<span class="review-label">Harnesses</span>
		<div class="review-harnesses">
			{#each state.selectedHarnesses as h (h)}
				<span class="review-badge">{h}</span>
			{/each}
		</div>
	</section>

	<div class="review-divider"></div>

	<section class="review-section">
		<span class="review-label">Embedding</span>
		<span class="review-value"
			>{embeddingLabel}
			{#if state.embeddingProvider !== "none" && state.embeddingModel}
				<span class="review-dim">/ {state.embeddingModel}</span>
			{/if}</span
		>
	</section>

	<section class="review-section">
		<span class="review-label">Extraction</span>
		<span class="review-value"
			>{extractionLabel}
			{#if state.extractionProvider !== "none" && state.extractionModel}
				<span class="review-dim">/ {state.extractionModel}</span>
			{/if}</span
		>
	</section>

	{#if state.extractionEndpoint}
		<section class="review-section">
			<span class="review-label">Endpoint</span>
			<span class="review-value review-mono">{state.extractionEndpoint}</span>
		</section>
	{/if}

	<section class="review-section">
		<span class="review-label">Session synthesis</span>
		<span class="review-value">{state.synthesisEnabled ? "Enabled" : "Disabled"}</span>
	</section>

	<p class="review-note">
		Additional settings (network mode, search tuning, auth, advanced pipeline options) are available in
		the Settings tab after saving.
	</p>
</div>

<style>
	.review-grid {
		display: grid;
		grid-template-columns: minmax(130px, 0.35fr) minmax(0, 1fr);
		gap: 10px 18px;
		align-items: baseline;
	}

	.review-section {
		display: contents;
	}

	.review-divider {
		grid-column: 1 / -1;
		height: 1px;
		background: linear-gradient(90deg, var(--sig-border-strong), transparent 80%);
		margin: 4px 0;
	}

	.review-label {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		padding-top: 2px;
	}

	.review-value {
		font-size: 13px;
		color: var(--sig-text-bright);
	}

	.review-dim {
		color: var(--sig-text-muted);
	}

	.review-mono {
		font-family: var(--font-mono, monospace);
		font-size: 12px;
	}

	.review-badge {
		display: inline-block;
		padding: 2px 8px;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		letter-spacing: 0.04em;
		color: var(--sig-text-bright);
		background: color-mix(in srgb, var(--sig-surface), transparent 5%);
	}

	.review-harnesses {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.review-note {
		grid-column: 1 / -1;
		margin: 10px 0 0;
		padding: 10px 12px;
		border: 1px solid var(--sig-border);
		border-radius: var(--sig-radius);
		background: var(--sig-surface);
		font-size: 12px;
		line-height: 1.35;
		color: var(--sig-text-muted);
	}

	@media (max-width: 620px) {
		.review-grid {
			grid-template-columns: 1fr;
			gap: 4px;
		}

		.review-label {
			padding-top: 8px;
			border-top: 1px solid var(--sig-border-strong);
		}
	}
</style>
