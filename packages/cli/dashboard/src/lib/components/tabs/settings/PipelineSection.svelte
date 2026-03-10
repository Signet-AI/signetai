<script lang="ts">
import AdvancedSection from "$lib/components/config/AdvancedSection.svelte";
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import {
	PIPELINE_CORE_BOOLS,
	PIPELINE_EXTRACTION_NUMS,
	PIPELINE_FEATURE_BOOLS,
	PIPELINE_RERANKER_BOOLS,
	PIPELINE_SEARCH_NUMS,
	PIPELINE_WORKER_NUMS,
	st,
} from "$lib/stores/settings.svelte";
import {
	getModelsByProvider,
	type ModelRegistryEntry,
} from "$lib/api";

const selectTriggerClass =
	"font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg";
const selectItemClass = "font-[family-name:var(--font-mono)] text-[11px] rounded-lg";

const EXTRACTION_PROVIDER_OPTIONS = [
	{ value: "ollama", label: "ollama" },
	{ value: "claude-code", label: "claude-code" },
	{ value: "codex", label: "codex" },
	{ value: "opencode", label: "opencode" },
	{ value: "anthropic", label: "anthropic" },
] as const;

// Hardcoded fallback presets — used when the registry API is unavailable
const FALLBACK_MODEL_PRESETS: Record<string, Array<{ value: string; label: string }>> = {
	"ollama": [
		{ value: "glm-4.7-flash", label: "glm-4.7-flash" },
		{ value: "qwen3:4b", label: "qwen3:4b" },
		{ value: "llama3", label: "llama3" },
	],
	"claude-code": [
		{ value: "haiku", label: "haiku" },
		{ value: "sonnet", label: "sonnet" },
	],
	"codex": [
		{ value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
		{ value: "gpt-5-codex", label: "gpt-5-codex" },
		{ value: "gpt-5-codex-mini", label: "gpt-5-codex-mini" },
	],
	"opencode": [
		{ value: "anthropic/claude-haiku-4-5-20251001", label: "anthropic/claude-haiku-4-5-20251001" },
		{ value: "anthropic/claude-sonnet-4-5-20250514", label: "anthropic/claude-sonnet-4-5-20250514" },
		{ value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash" },
	],
	"anthropic": [
		{ value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
		{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
		{ value: "claude-opus-4-6", label: "Claude Opus 4.6" },
	],
};

// Dynamic model registry — fetched from daemon API
let dynamicModels = $state<Record<string, ModelRegistryEntry[]>>({});
let registryLoaded = $state(false);

$effect(() => {
	getModelsByProvider().then((models) => {
		if (models && Object.keys(models).length > 0) {
			dynamicModels = models;
			registryLoaded = true;
		}
	});
});

function getModelPresets(provider: string): Array<{ value: string; label: string }> {
	if (registryLoaded && dynamicModels[provider]) {
		return dynamicModels[provider].map((m) => ({
			value: m.id,
			label: m.label,
		}));
	}
	return FALLBACK_MODEL_PRESETS[provider] ?? [];
}

function extractionProvider(): string {
	return st.aStr(["memory", "pipelineV2", "extractionProvider"]);
}

function extractionModelPresets() {
	const provider = extractionProvider();
	return provider ? getModelPresets(provider) : [];
}

function extractionModelSelectValue(): string {
	const model = st.aStr(["memory", "pipelineV2", "extractionModel"]);
	if (!model) return "";
	return extractionModelPresets().some((preset) => preset.value === model)
		? model
		: "__custom__";
}

function isKnownPreset(model: string): boolean {
	for (const presets of Object.values(dynamicModels)) {
		if (presets.some((p) => p.id === model)) return true;
	}
	for (const presets of Object.values(FALLBACK_MODEL_PRESETS)) {
		if (presets.some((p) => p.value === model)) return true;
	}
	return false;
}

function defaultModelForProvider(provider: string): string {
	const presets = getModelPresets(provider);
	return presets[0]?.value ?? "";
}

function setNum(path: string[]) {
	return (e: Event) => {
		st.aSetNum(path, (e.currentTarget as HTMLInputElement).value);
	};
}

function setBool(path: string[]) {
	return (v: boolean | string | undefined) => {
		st.aSetBool(path, !!v);
	};
}

function setStr(path: string[]) {
	return (e: Event) => {
		st.aSetStr(path, (e.currentTarget as HTMLInputElement).value);
	};
}

function setSelect(path: string[]) {
	return (v: string | undefined) => {
		st.aSetStr(path, v ?? "");
	};
}

function setExtractionProvider(v: string | undefined): void {
	const nextProvider = v ?? "";
	const currentModel = st.aStr(["memory", "pipelineV2", "extractionModel"]);
	st.aSetStr(["memory", "pipelineV2", "extractionProvider"], nextProvider);
	if (!nextProvider) return;
	if (!currentModel || isKnownPreset(currentModel)) {
		st.aSetStr(["memory", "pipelineV2", "extractionModel"], defaultModelForProvider(nextProvider));
	}
}

function setExtractionModelPreset(v: string | undefined): void {
	if (!v || v === "__custom__") return;
	st.aSetStr(["memory", "pipelineV2", "extractionModel"], v);
}

const TOP_LEVEL_FEATURE_KEYS = ["allowUpdateDelete", "graphEnabled", "autonomousEnabled", "semanticContradictionEnabled"] as const;
const ADVANCED_FEATURE_KEYS = ["autonomousFrozen"] as const;
</script>

{#if st.agentFile}
	<FormSection description="V2 memory pipeline. Runs LLM-based fact extraction on incoming memories, then decides whether to write, update, or skip. Lives under memory.pipelineV2 in agent.yaml.">
		<FormField label={PIPELINE_CORE_BOOLS[0].key} description={PIPELINE_CORE_BOOLS[0].desc}>
			<Switch checked={st.aBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[0].key])} onCheckedChange={setBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[0].key])} />
		</FormField>

		<FormField label="Extraction provider" description="LLM backend for fact extraction. Ollama runs locally; claude-code uses Claude Code CLI; codex uses the local Codex CLI; opencode uses the OpenCode server; anthropic uses direct API.">
			<Select.Root
				type="single"
				value={st.aStr(["memory", "pipelineV2", "extractionProvider"])}
				onValueChange={setExtractionProvider}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.aStr(["memory", "pipelineV2", "extractionProvider"]) || "\u2014 select \u2014"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="\u2014 select \u2014" />
					{#each EXTRACTION_PROVIDER_OPTIONS as option (option.value)}
						<Select.Item class={selectItemClass} value={option.value} label={option.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</FormField>

		<FormField label="Extraction model" description={registryLoaded ? "Models auto-discovered from provider. Switch to custom for any supported model string." : "Choose a provider default or switch to custom. Models will auto-update when the registry connects."}>
			<div class="flex flex-col gap-2">
				<Select.Root
					type="single"
					value={extractionModelSelectValue()}
					onValueChange={setExtractionModelPreset}
				>
					<Select.Trigger class={selectTriggerClass}>
						{extractionModelSelectValue() === "__custom__"
							? `custom: ${st.aStr(["memory", "pipelineV2", "extractionModel"])}`
							: st.aStr(["memory", "pipelineV2", "extractionModel"]) || "\u2014 select \u2014"}
					</Select.Trigger>
					<Select.Content class={selectContentClass}>
						<Select.Item class={selectItemClass} value="" label="\u2014 select \u2014" />
						{#each extractionModelPresets() as preset (preset.value)}
							<Select.Item class={selectItemClass} value={preset.value} label={preset.label} />
						{/each}
						<Select.Item class={selectItemClass} value="__custom__" label="custom" />
					</Select.Content>
				</Select.Root>
				{#if extractionModelSelectValue() === "__custom__" || extractionModelPresets().length === 0}
					<Input value={st.aStr(["memory", "pipelineV2", "extractionModel"])} oninput={setStr(["memory", "pipelineV2", "extractionModel"])} placeholder="custom model id" />
				{/if}
				{#if registryLoaded}
					<span class="text-[9px] text-[var(--sig-text-muted)] tracking-wider uppercase">auto-discovered from registry</span>
				{/if}
			</div>
		</FormField>

		{#each PIPELINE_FEATURE_BOOLS.filter(b => TOP_LEVEL_FEATURE_KEYS.includes(b.key as typeof TOP_LEVEL_FEATURE_KEYS[number])) as { key, desc } (key)}
			<FormField label={key} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		{#each PIPELINE_RERANKER_BOOLS as { key, desc } (key)}
			<FormField label={key} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Usage Limit Watcher
		</div>
		<FormField label="usageWatcherEnabled" description="Auto-downgrade to cheaper models when usage limits are detected. Protects extraction pipelines from stalling.">
			<Switch checked={st.aBool(["memory", "pipelineV2", "usageWatcher", "enabled"])} onCheckedChange={setBool(["memory", "pipelineV2", "usageWatcher", "enabled"])} />
		</FormField>
		<FormField label="restartOnDowngrade" description="Automatically restart the daemon after a model downgrade to apply the new config.">
			<Switch checked={st.aBool(["memory", "pipelineV2", "usageWatcher", "restartOnDowngrade"])} onCheckedChange={setBool(["memory", "pipelineV2", "usageWatcher", "restartOnDowngrade"])} />
		</FormField>

		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Model Registry
		</div>
		<FormField label="modelRegistryEnabled" description="Auto-discover available models from each provider. New models appear without code changes.">
			<Switch checked={st.aBool(["memory", "pipelineV2", "modelRegistry", "enabled"])} onCheckedChange={setBool(["memory", "pipelineV2", "modelRegistry", "enabled"])} />
		</FormField>

		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Predictor
		</div>
		<FormField label="enabled" description="Enable the predictive memory scorer. Learns which memories are most useful based on agent feedback.">
			<Switch checked={st.aBool(["memory", "pipelineV2", "predictor", "enabled"])} onCheckedChange={setBool(["memory", "pipelineV2", "predictor", "enabled"])} />
		</FormField>
		<FormField label="agentFeedback" description="Allow the agent to provide relevance feedback on recalled memories.">
			<Switch checked={st.aBool(["memory", "pipelineV2", "predictorPipeline", "agentFeedback"])} onCheckedChange={setBool(["memory", "pipelineV2", "predictorPipeline", "agentFeedback"])} />
		</FormField>
		<FormField label="trainingTelemetry" description="Contribute anonymized training signals to improve the shared base model.">
			<Switch checked={st.aBool(["memory", "pipelineV2", "predictorPipeline", "trainingTelemetry"])} onCheckedChange={setBool(["memory", "pipelineV2", "predictorPipeline", "trainingTelemetry"])} />
		</FormField>

		<AdvancedSection>
			<FormField label={PIPELINE_CORE_BOOLS[1].key} description={PIPELINE_CORE_BOOLS[1].desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[1].key])} onCheckedChange={setBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[1].key])} />
			</FormField>
			<FormField label={PIPELINE_CORE_BOOLS[2].key} description={PIPELINE_CORE_BOOLS[2].desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[2].key])} onCheckedChange={setBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[2].key])} />
			</FormField>
			{#each PIPELINE_FEATURE_BOOLS.filter(b => ADVANCED_FEATURE_KEYS.includes(b.key as typeof ADVANCED_FEATURE_KEYS[number])) as { key, desc } (key)}
				<FormField label={key} description={desc}>
					<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
				</FormField>
			{/each}

			<FormField label="Maintenance mode" description="'observe' logs diagnostics without changes. 'execute' attempts repairs. Only works when autonomousEnabled is true.">
				<Select.Root
					type="single"
					value={st.aStr(["memory", "pipelineV2", "maintenanceMode"])}
					onValueChange={setSelect(["memory", "pipelineV2", "maintenanceMode"])}
				>
					<Select.Trigger class={selectTriggerClass}>
						{st.aStr(["memory", "pipelineV2", "maintenanceMode"]) || "\u2014 select \u2014"}
					</Select.Trigger>
					<Select.Content class={selectContentClass}>
						<Select.Item class={selectItemClass} value="" label="\u2014 select \u2014" />
						<Select.Item class={selectItemClass} value="observe" label="observe" />
						<Select.Item class={selectItemClass} value="execute" label="execute" />
					</Select.Content>
				</Select.Root>
			</FormField>

			{#each PIPELINE_EXTRACTION_NUMS as { key, label, desc, min, max, step } (key)}
				<FormField {label} description={desc}>
					<Input type="number" {min} {max} {step} value={st.aNum(["memory", "pipelineV2", key])} oninput={setNum(["memory", "pipelineV2", key])} />
				</FormField>
			{/each}

			{#each PIPELINE_SEARCH_NUMS as { key, label, desc, min, max, step } (key)}
				<FormField {label} description={desc}>
					<Input type="number" {min} {max} {step} value={st.aNum(["memory", "pipelineV2", key])} oninput={setNum(["memory", "pipelineV2", key])} />
				</FormField>
			{/each}

			{#each PIPELINE_WORKER_NUMS as { key, label, desc, min, max, step } (key)}
				<FormField {label} description={desc}>
					<Input type="number" {min} {max} {step} value={st.aNum(["memory", "pipelineV2", key])} oninput={setNum(["memory", "pipelineV2", key])} />
				</FormField>
			{/each}
		</AdvancedSection>

	</FormSection>
{/if}
