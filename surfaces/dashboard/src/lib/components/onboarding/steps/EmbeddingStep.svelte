<script lang="ts">
	import { Input } from "$lib/components/ui/input/index.js";
	import * as Select from "$lib/components/ui/select/index.js";
	import {
		EMBEDDING_MODEL_PRESETS,
		EMBEDDING_PROVIDER_OPTIONS,
		type EmbeddingProvider,
		type OnboardingState,
	} from "../onboarding-state.svelte";

	interface Props {
		state: OnboardingState;
	}

	const { state }: Props = $props();

	const selectTriggerClass =
		"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
	const selectContentClass =
		"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg";
	const selectItemClass = "font-mono text-[11px] rounded-lg";

	const providerOption = $derived(
		EMBEDDING_PROVIDER_OPTIONS.find((o) => o.value === state.embeddingProvider),
	);
	const modelPresets = $derived(EMBEDDING_MODEL_PRESETS[state.embeddingProvider] ?? []);
	const needsEndpoint = $derived(
		state.embeddingProvider === "llama-cpp" ||
			state.embeddingProvider === "ollama" ||
			state.embeddingProvider === "openai",
	);

	function chooseProvider(next: EmbeddingProvider): void {
		const option = EMBEDDING_PROVIDER_OPTIONS.find((o) => o.value === next);
		if (!option) return;
		state.embeddingProvider = next;
		state.embeddingModel = option.defaultModel;
		state.embeddingEndpoint = option.defaultEndpoint;
	}

	export function validate(): string[] {
		if (state.embeddingProvider === "none") return [];
		if (!state.embeddingModel.trim()) return ["Embedding model is required."];
		return [];
	}
</script>

<div class="embedding-step">
	<p class="step-hint">
		Embedding turns text into vectors for semantic search. The built-in native provider works out of
		the box with no setup.
	</p>

	<div class="provider-grid">
		{#each EMBEDDING_PROVIDER_OPTIONS as option (option.value)}
			<button
				type="button"
				class="provider-card sig-switch"
				class:provider-card-active={state.embeddingProvider === option.value}
				onclick={() => chooseProvider(option.value)}
				aria-pressed={state.embeddingProvider === option.value}
			>
				<span class="provider-radio" aria-hidden="true"></span>
				<strong>{option.label}</strong>
				{#if state.embeddingProvider === option.value}
					<span class="selected-badge">selected</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if state.embeddingProvider !== "none"}
		<div class="config-fields">
			<div class="field-row">
				<label class="field">
					<span class="field-label">Model</span>
					<Select.Root
						type="single"
						value={modelPresets.some((p) => p.value === state.embeddingModel)
							? state.embeddingModel
							: "__custom__"}
						onValueChange={(v: string) => {
							if (v !== "__custom__") state.embeddingModel = v;
						}}
					>
						<Select.Trigger class={selectTriggerClass}>
							{state.embeddingModel || "select model"}
						</Select.Trigger>
						<Select.Content class={selectContentClass}>
							{#each modelPresets as preset (preset.value)}
								<Select.Item class={selectItemClass} value={preset.value}>
									{preset.label}
								</Select.Item>
							{/each}
							<Select.Item class={selectItemClass} value="__custom__">Custom...</Select.Item>
						</Select.Content>
					</Select.Root>
				</label>

				{#if needsEndpoint}
					<label class="field">
						<span class="field-label">Base URL</span>
						<Input
							class="onboarding-input"
							bind:value={state.embeddingEndpoint}
							placeholder={providerOption?.defaultEndpoint ?? "https://..."}
						/>
					</label>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.embedding-step {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.step-hint {
		margin: 0;
		font-size: 13px;
		line-height: 1.4;
		color: var(--sig-text);
	}

	.provider-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
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

	.provider-card strong {
		display: block;
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

	.config-fields {
		display: flex;
		flex-direction: column;
		gap: 10px;
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
