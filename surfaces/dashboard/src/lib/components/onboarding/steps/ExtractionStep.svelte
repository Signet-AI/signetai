<script lang="ts">
	import { Checkbox } from "$lib/components/ui/checkbox/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { defaultPipelineModel, type PipelineProviderChoice } from "@signet/core/pipeline-providers";
	import {
		EXTRACTION_MODEL_PRESETS,
		EXTRACTION_PROVIDER_OPTIONS,
		EXTRACTION_SAFETY_TEXT,
		RECOMMENDED_EXTRACTION,
		type OnboardingState,
	} from "../onboarding-state.svelte";

	interface Props {
		state: OnboardingState;
	}

	const { state }: Props = $props();

	const providerOption = $derived(
		EXTRACTION_PROVIDER_OPTIONS.find((o) => o.value === state.extractionProvider) ??
			EXTRACTION_PROVIDER_OPTIONS[0],
	);
	const modelPresets = $derived(EXTRACTION_MODEL_PRESETS[state.extractionProvider] ?? []);
	const needsEndpoint = $derived(
		providerOption.mode === "local" || providerOption.mode === "api",
	);

	function chooseProvider(next: PipelineProviderChoice): void {
		state.extractionProvider = next;
		state.extractionModel = EXTRACTION_MODEL_PRESETS[next]?.[0] ?? defaultPipelineModel(next);
		state.extractionEndpoint =
			EXTRACTION_PROVIDER_OPTIONS.find((o) => o.value === next)?.endpointPlaceholder ?? "";
		if (next === "none") state.extractionEndpoint = "";
	}

	function isRecommended(provider: PipelineProviderChoice): boolean {
		return RECOMMENDED_EXTRACTION.includes(provider);
	}

	export function validate(): string[] {
		if (state.extractionProvider === "none") return [];
		if (!state.extractionModel.trim()) return ["Extraction model is required."];
		if (
			needsEndpoint &&
			state.extractionEndpoint.trim() &&
			!/^https?:\/\//.test(state.extractionEndpoint.trim())
		) {
			return ["Endpoint must be an http:// or https:// URL."];
		}
		return [];
	}
</script>

<div class="extraction-step">
	<p class="step-hint">{EXTRACTION_SAFETY_TEXT}</p>

	<div class="provider-grid">
		<p class="provider-group-title">Recommended routes</p>
		{#each EXTRACTION_PROVIDER_OPTIONS as option (option.value)}
			{#if isRecommended(option.value)}
				<button
					type="button"
					class="provider-card sig-switch"
					class:provider-card-active={state.extractionProvider === option.value}
					onclick={() => chooseProvider(option.value)}
					aria-pressed={state.extractionProvider === option.value}
				>
					<span class="provider-radio" aria-hidden="true"></span>
					<span class="provider-mode">{option.mode}</span>
					{#if state.extractionProvider === option.value}
						<span class="selected-badge">selected</span>
					{/if}
					<strong>{option.label}</strong>
				</button>
			{/if}
		{/each}

		<button
			type="button"
			class="advanced-toggle sig-switch"
			onclick={() => (state.showAdvancedProviders = !state.showAdvancedProviders)}
			aria-expanded={state.showAdvancedProviders}
		>
			<span>{state.showAdvancedProviders ? "Hide advanced routes" : "Show advanced routes"}</span>
		</button>

		{#if state.showAdvancedProviders}
			<p class="provider-group-title provider-group-title-secondary">Advanced routes</p>
			{#each EXTRACTION_PROVIDER_OPTIONS as option (option.value)}
				{#if !isRecommended(option.value)}
					<button
						type="button"
						class="provider-card provider-card-compact sig-switch"
						class:provider-card-active={state.extractionProvider === option.value}
						onclick={() => chooseProvider(option.value)}
						aria-pressed={state.extractionProvider === option.value}
					>
						<span class="provider-radio" aria-hidden="true"></span>
						<span class="provider-mode">{option.mode}</span>
						{#if state.extractionProvider === option.value}
							<span class="selected-badge">selected</span>
						{/if}
						<strong>{option.label}</strong>
					</button>
				{/if}
			{/each}
		{/if}
	</div>

	<div class="provider-detail">
		<div class="detail-banner">
			<span>{providerOption.mode}</span>
			<p>{providerOption.detail}</p>
		</div>

		{#if state.extractionProvider === "acpx"}
			<div class="field">
				<span class="field-label">ACPX harness</span>
				<div class="choice-row">
					{#each state.selectedHarnesses as h (h)}
						<button
							type="button"
							class="choice-pill sig-switch"
							class:choice-pill-active={state.selectedHarness === h}
							onclick={() => (state.selectedHarness = h)}
						>
							{h}
						</button>
					{/each}
					{#if state.selectedHarnesses.length === 0}
						<small class="empty-hint">Select at least one harness in the previous step.</small>
					{/if}
				</div>
			</div>
		{/if}

		<div class="field-row">
			<label class="field">
				<span class="field-label">Model</span>
				<Input
					class="onboarding-input"
					bind:value={state.extractionModel}
					placeholder="model id"
					disabled={state.extractionProvider === "none"}
				/>
			</label>
			{#if needsEndpoint}
				<label class="field">
					<span class="field-label">Endpoint URL</span>
					<Input
						class="onboarding-input"
						bind:value={state.extractionEndpoint}
						placeholder={providerOption.endpointPlaceholder ?? "https://..."}
					/>
				</label>
			{/if}
		</div>

		{#if modelPresets.length > 0 && state.extractionProvider !== "none"}
			<div class="choice-row preset-row" aria-label="Model presets">
				{#each modelPresets as preset (preset)}
					<button
						type="button"
						class="choice-pill sig-switch"
						class:choice-pill-active={state.extractionModel === preset}
						onclick={() => (state.extractionModel = preset)}
					>
						{preset}
					</button>
				{/each}
			</div>
		{/if}

		<label class="inline-toggle sig-switch">
			<Checkbox
				checked={state.synthesisEnabled}
				onCheckedChange={(checked) => (state.synthesisEnabled = !!checked)}
			/>
			<span>Use the same provider for session synthesis</span>
		</label>
	</div>
</div>

<style>
	.extraction-step {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.step-hint {
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: var(--sig-bg);
		font-size: 12px;
		line-height: 1.35;
		color: var(--sig-text-muted);
	}

	.provider-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.provider-group-title {
		grid-column: 1 / -1;
		margin: 2px 0 -2px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.provider-group-title-secondary {
		margin-top: 8px;
		color: var(--sig-text-muted);
	}

	.provider-card {
		position: relative;
		min-height: 40px;
		padding: 8px 10px 8px 30px;
		text-align: left;
		cursor: pointer;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: color-mix(in srgb, var(--sig-surface), transparent 5%);
		color: var(--sig-text);
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.provider-card:hover {
		border-color: var(--sig-highlight);
	}

	.provider-card-active {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 10%);
		box-shadow: var(--sig-glow-highlight), inset 3px 0 0 var(--sig-highlight),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	.provider-card-compact {
		min-height: 32px;
	}

	.provider-radio {
		position: absolute;
		top: 13px;
		left: 10px;
		width: 12px;
		height: 12px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
	}

	.provider-card-active .provider-radio {
		border-color: var(--sig-highlight);
		background: var(--sig-highlight);
		box-shadow: inset 0 0 0 3px var(--sig-bg),
			0 0 9px color-mix(in srgb, var(--sig-highlight), transparent 36%);
	}

	.provider-mode {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.provider-card strong {
		display: block;
		margin: 4px 0 0;
		font-family: var(--font-display, monospace);
		font-size: 13px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.selected-badge {
		position: absolute;
		top: 9px;
		right: 10px;
		font-family: var(--font-mono, monospace);
		font-size: 9px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.advanced-toggle {
		grid-column: 1 / -1;
		justify-content: center;
		min-height: 28px;
		padding: 6px 10px;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text);
		cursor: pointer;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: color-mix(in srgb, var(--sig-surface), transparent 5%);
	}

	.provider-detail {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.detail-banner {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 8px 10px;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: var(--sig-bg);
	}

	.detail-banner span {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.detail-banner p {
		margin: 0;
		font-size: 12px;
		line-height: 1.35;
		color: var(--sig-text-muted);
	}

	.field-row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.field-label {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.choice-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.preset-row {
		padding-top: 2px;
	}

	.choice-pill {
		padding: 7px 10px;
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		color: var(--sig-text);
		cursor: pointer;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: color-mix(in srgb, var(--sig-surface), transparent 5%);
	}

	.choice-pill-active {
		border-color: var(--sig-highlight);
		color: var(--sig-text-bright);
		background: var(--sig-highlight-muted);
	}

	.empty-hint {
		font-size: 12px;
		color: var(--sig-text-muted);
	}

	.inline-toggle {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 10px;
		font-size: 12px;
		color: var(--sig-text);
		cursor: pointer;
	}

	:global(.onboarding-input) {
		border-radius: var(--sig-radius) !important;
		border-color: var(--sig-border-strong) !important;
		background: color-mix(in srgb, var(--sig-bg), transparent 6%) !important;
		color: var(--sig-text-bright) !important;
		font-family: var(--font-mono, monospace) !important;
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.28) !important;
	}

	@media (max-width: 620px) {
		.provider-grid,
		.field-row {
			grid-template-columns: 1fr;
		}
	}
</style>
