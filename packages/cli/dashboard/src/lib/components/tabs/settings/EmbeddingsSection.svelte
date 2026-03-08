<script lang="ts">
	import FormField from "$lib/components/config/FormField.svelte";
	import FormSection from "$lib/components/config/FormSection.svelte";
	import { Input } from "$lib/components/ui/input/index.js";
	import * as Select from "$lib/components/ui/select/index.js";
	import { st } from "$lib/stores/settings.svelte";

	const selectTriggerClass =
		"font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
	const selectContentClass =
		"font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg";
	const selectItemClass = "font-[family-name:var(--font-mono)] text-[11px] rounded-lg";

	const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
	const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

	const EMBEDDING_PROVIDER_OPTIONS = [
		{ value: "native", label: "native (built-in)" },
		{ value: "ollama", label: "ollama" },
		{ value: "openai", label: "openai" },
		{ value: "none", label: "none (disable vectors)" },
	] as const;

	const EMBEDDING_MODEL_PRESETS = {
		native: [
			{ value: "nomic-embed-text-v1.5", label: "nomic-embed-text-v1.5", dimensions: 768 },
		],
		ollama: [
			{ value: "nomic-embed-text", label: "nomic-embed-text (recommended)", dimensions: 768 },
			{ value: "all-minilm", label: "all-minilm", dimensions: 384 },
			{ value: "mxbai-embed-large", label: "mxbai-embed-large", dimensions: 1024 },
		],
		openai: [
			{ value: "text-embedding-3-small", label: "text-embedding-3-small (recommended)", dimensions: 1536 },
			{ value: "text-embedding-3-large", label: "text-embedding-3-large", dimensions: 3072 },
		],
		none: [],
	} as const;

	type EmbeddingProvider = keyof typeof EMBEDDING_MODEL_PRESETS;

	function embPath(): string[] {
		return st.embPath();
	}

	function embeddingProvider(): EmbeddingProvider | "" {
		const provider = st.sStr([...embPath(), "provider"]);
		return provider in EMBEDDING_MODEL_PRESETS ? (provider as EmbeddingProvider) : "";
	}

	function embeddingModelPresets() {
		const provider = embeddingProvider();
		return provider ? EMBEDDING_MODEL_PRESETS[provider] : [];
	}

	function embeddingModelSelectValue(): string {
		const model = st.sStr([...embPath(), "model"]);
		if (!model) return "";
		return embeddingModelPresets().some((preset) => preset.value === model)
			? model
			: "__custom__";
	}

	function isKnownPreset(model: string): boolean {
		return Object.values(EMBEDDING_MODEL_PRESETS).some((presets) =>
			presets.some((preset) => preset.value === model),
		);
	}

	function defaultBaseUrlForProvider(provider: EmbeddingProvider): string {
		if (provider === "ollama") return DEFAULT_OLLAMA_BASE_URL;
		if (provider === "openai") return DEFAULT_OPENAI_BASE_URL;
		return "";
	}

	function setProviderDefaults(provider: EmbeddingProvider): void {
		const currentModel = st.sStr([...embPath(), "model"]);
		const currentBaseUrl = st.sStr([...embPath(), "base_url"]);
		const presets = EMBEDDING_MODEL_PRESETS[provider];
		const defaultPreset = presets[0];

		if ((!currentModel || isKnownPreset(currentModel)) && defaultPreset) {
			st.sSetStr([...embPath(), "model"], defaultPreset.value);
			st.sSetNum([...embPath(), "dimensions"], defaultPreset.dimensions);
		}

		const nextBaseUrl = defaultBaseUrlForProvider(provider);
		if (
			currentBaseUrl === "" ||
			currentBaseUrl === DEFAULT_OLLAMA_BASE_URL ||
			currentBaseUrl === DEFAULT_OPENAI_BASE_URL
		) {
			st.sSetStr([...embPath(), "base_url"], nextBaseUrl);
		}
	}

	function handleProviderChange(v: string | undefined): void {
		const nextProvider = (v ?? "") as EmbeddingProvider | "";
		st.sSetStr([...embPath(), "provider"], nextProvider);
		if (!nextProvider) return;
		if (nextProvider === "none") return;
		setProviderDefaults(nextProvider);
	}

	function handleModelPresetChange(v: string | undefined): void {
		if (!v || v === "__custom__") return;
		const preset = embeddingModelPresets().find((candidate) => candidate.value === v);
		if (!preset) return;
		st.sSetStr([...embPath(), "model"], preset.value);
		st.sSetNum([...embPath(), "dimensions"], preset.dimensions);
	}
</script>

{#if st.settingsFileName}
	<FormSection description="Vector embedding configuration for semantic memory search. Provider defaults keep model, dimensions, and base URL aligned so search does not drift into a broken state.">
		<FormField label="Provider" description="Embedding backend. Native runs built-in. Ollama runs locally. OpenAI uses the official embeddings API and requires an API key.">
			<Select.Root
				type="single"
				value={st.sStr([...embPath(), "provider"])}
				onValueChange={handleProviderChange}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.sStr([...embPath(), "provider"]) || "— select —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="— select —" />
					{#each EMBEDDING_PROVIDER_OPTIONS as option (option.value)}
						<Select.Item class={selectItemClass} value={option.value} label={option.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</FormField>

		{#if embeddingProvider() && embeddingProvider() !== "none"}
			<div class="flex items-center gap-2 px-3 py-2 text-[10px] font-[family-name:var(--font-mono)] text-[var(--sig-warning,#d4a017)] bg-[color-mix(in_srgb,var(--sig-warning,#d4a017)_10%,transparent)] border border-[var(--sig-warning,#d4a017)]">
				(!) Changing provider or model will re-embed your entire memory database
			</div>

			<FormField label="Model" description="Choose a recommended default or switch to custom for a specific embedding model. OpenAI's closest general-purpose replacement for the built-in nomic default is text-embedding-3-small.">
				<div class="flex flex-col gap-2">
					<Select.Root
						type="single"
						value={embeddingModelSelectValue()}
						onValueChange={handleModelPresetChange}
					>
						<Select.Trigger class={selectTriggerClass}>
							{embeddingModelSelectValue() === "__custom__"
								? `custom: ${st.sStr([...embPath(), "model"])}`
								: st.sStr([...embPath(), "model"]) || "— select —"}
						</Select.Trigger>
						<Select.Content class={selectContentClass}>
							<Select.Item class={selectItemClass} value="" label="— select —" />
							{#each embeddingModelPresets() as preset (preset.value)}
								<Select.Item class={selectItemClass} value={preset.value} label={preset.label} />
							{/each}
							<Select.Item class={selectItemClass} value="__custom__" label="custom" />
						</Select.Content>
					</Select.Root>
					{#if embeddingModelSelectValue() === "__custom__" || embeddingModelPresets().length === 0}
						<Input
							value={st.sStr([...embPath(), "model"])}
							oninput={(e) => st.sSetStr([...embPath(), "model"], e.currentTarget.value)}
							placeholder="custom model id"
						/>
					{/if}
				</div>
			</FormField>

			{#if embeddingProvider() === "ollama" || embeddingProvider() === "openai"}
				<FormField label="Base URL" description="Ollama defaults to http://localhost:11434. OpenAI defaults to https://api.openai.com/v1. Switching providers keeps the matching default unless you override it.">
					<Input
						value={st.sStr([...embPath(), "base_url"])}
						oninput={(e) => st.sSetStr([...embPath(), "base_url"], e.currentTarget.value)}
					/>
				</FormField>
			{/if}

			{#if embeddingProvider() === "openai"}
				<FormField label="API Key" description="Required for OpenAI. Use $secret:OPENAI_API_KEY to reference a stored secret instead of plaintext.">
					<Input
						type="password"
						value={st.sStr([...embPath(), "api_key"])}
						oninput={(e) => st.sSetStr([...embPath(), "api_key"], e.currentTarget.value)}
						placeholder="$secret:OPENAI_API_KEY"
					/>
				</FormField>
			{/if}
		{/if}
	</FormSection>
{/if}
