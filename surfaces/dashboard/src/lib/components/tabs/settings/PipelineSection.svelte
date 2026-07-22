<script lang="ts">
import AdvancedSection from "$lib/components/config/AdvancedSection.svelte";
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { humanizeConfigKey } from "$lib/issue-848-format";
import {
	PIPELINE_CONTRADICTION_NUMS,
	PIPELINE_CORE_BOOLS,
	PIPELINE_EXTRACTION_NUMS,
	PIPELINE_FEATURE_BOOLS,
	PIPELINE_RERANKER_BOOLS,
	PIPELINE_SEARCH_NUMS,
	PIPELINE_WORKER_NUMS,
	st,
} from "$lib/stores/settings.svelte";
import { modelPresetsForProvider } from "@signet/core/llm-model-catalog";
import { defaultPipelineModel } from "@signet/core/pipeline-providers";
import {
	ACPX_DASHBOARD_AGENT_OPTIONS,
	type AcpxDashboardAgent,
	DEFAULT_OPENAI_COMPATIBLE_ENDPOINT,
	applyAcpxDashboardSetup,
	defaultAcpxDashboardAgent,
	defaultAcpxDashboardModel,
	hasExplicitSynthesisConfig,
	hasExplicitSynthesisProvider,
	resolveExtractionEndpoint,
	resolveSynthesisEnabled,
	resolveSynthesisEndpoint,
	resolveSynthesisModel,
	resolveSynthesisProvider,
	resolveSynthesisTimeout,
} from "./pipeline-settings";

const selectTriggerClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg";
const selectItemClass = "font-mono text-[11px] rounded-lg";

const EXTRACTION_SAFETY_TEXT =
	"intended usage: claude code on haiku, codex cli on gpt-5.4-mini with a pro/max subscription, or local providers (llama.cpp or ollama) at qwen3:4b or larger. remote api extraction can stack up extreme fees fast. set provider to none on a vps if you do not want background extraction.";

const EXTRACTION_PROVIDER_OPTIONS = [
	{ value: "none", label: "none (disable extraction)" },
	{ value: "acpx", label: "acpx (recommended dashboard setup)" },
	{ value: "llama-cpp", label: "llama-cpp" },
	{ value: "ollama", label: "ollama" },
	{ value: "claude-code", label: "claude-code" },
	{ value: "codex", label: "codex" },
	{ value: "opencode", label: "opencode" },
	{ value: "anthropic", label: "anthropic" },
	{ value: "openrouter", label: "openrouter" },
	{ value: "openai-compatible", label: "openai-compatible" },
] as const;

function getModelPresets(provider: string): Array<{ value: string; label: string }> {
	return modelPresetsForProvider(provider).map((preset) => ({
		value: preset.value,
		label: preset.label,
	}));
}

function pickPreferredModel(provider: string, presets: Array<{ value: string; label: string }>): string {
	const vals = presets.map((preset) => preset.value);
	if (provider === "acpx") {
		return vals.find((v) => v.toLowerCase().includes("mini")) ?? vals[0] ?? "";
	}
	if (provider === "claude-code" || provider === "anthropic") {
		return vals.find((v) => v.toLowerCase().includes("haiku")) ?? vals[0] ?? "";
	}
	if (provider === "codex") {
		return vals.find((v) => v.toLowerCase().includes("mini")) ?? vals[0] ?? "";
	}
	if (provider === "ollama") {
		return vals.find((v) => v === "qwen3:4b") ?? vals[0] ?? "";
	}
	if (provider === "llama-cpp") {
		return vals.find((v) => v === "qwen3:4b") ?? vals[0] ?? "";
	}
	if (provider === "opencode") {
		return (
			vals.find((v) => v.toLowerCase().includes("haiku")) ??
			vals.find((v) => v.toLowerCase().includes("flash")) ??
			vals[0] ??
			""
		);
	}
	if (provider === "openrouter") {
		return (
			vals.find((v) => v.toLowerCase().includes("gpt-4o-mini")) ??
			vals.find((v) => v.toLowerCase().includes("haiku")) ??
			vals.find((v) => v.toLowerCase().includes("flash")) ??
			vals[0] ??
			""
		);
	}
	if (provider === "openai-compatible") {
		return vals.find((v) => v.toLowerCase().includes("mini")) ?? vals[0] ?? "";
	}
	return vals[0] ?? "";
}

function extractionProvider(): string {
	return st.aStr(["memory", "pipelineV2", "extractionProvider"]);
}

function extractionModelPresets() {
	const provider = extractionProvider();
	return provider ? getModelPresets(provider) : [];
}

let customModelActive = $state(false);

function extractionModelSelectValue(): string {
	if (customModelActive) return "__custom__";
	const model = st.aStr(["memory", "pipelineV2", "extractionModel"]);
	if (!model) return "";
	return extractionModelPresets().some((preset) => preset.value === model) ? model : "__custom__";
}

function isKnownPreset(model: string): boolean {
	return EXTRACTION_PROVIDER_OPTIONS.some((option) =>
		getModelPresets(option.value).some((preset) => preset.value === model),
	);
}

function isKnownProvider(provider: string): provider is Parameters<typeof defaultPipelineModel>[0] {
	return EXTRACTION_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

function defaultModelForProvider(provider: string): string {
	const presets = getModelPresets(provider);
	if (presets.length > 0) return pickPreferredModel(provider, presets);
	return isKnownProvider(provider) ? defaultPipelineModel(provider) : "";
}

function extractionModel(): string {
	return st.aStr(["memory", "pipelineV2", "extractionModel"]);
}

function extractionEndpoint(): string {
	return resolveExtractionEndpoint(st.agent);
}

function extractionDisabled(): boolean {
	return extractionProvider() === "none";
}

function providerRisky(provider: string): boolean {
	return (
		provider === "acpx" ||
		provider === "anthropic" ||
		provider === "openrouter" ||
		provider === "openai-compatible" ||
		provider === "opencode"
	);
}

function extractionProviderRisky(): boolean {
	return providerRisky(extractionProvider());
}

function modelNeedsCostWarning(provider: string, model: string): boolean {
	const normalized = model.toLowerCase();
	if (!normalized) return false;
	if (provider === "claude-code") return !normalized.includes("haiku");
	if (provider === "codex") return normalized !== "gpt-5.4-mini";
	return false;
}

function extractionModelNeedsCostWarning(): boolean {
	const provider = extractionProvider();
	const model = extractionModel();
	return modelNeedsCostWarning(provider, model);
}

function synthesisProvider(): string {
	return resolveSynthesisProvider(st.agent);
}

function synthesisModel(): string {
	return resolveSynthesisModel(st.agent);
}

function synthesisEndpoint(): string {
	return resolveSynthesisEndpoint(st.agent);
}

function synthesisTimeout(): number {
	return resolveSynthesisTimeout(st.agent);
}

function synthesisDisabled(): boolean {
	return !resolveSynthesisEnabled(st.agent);
}

function synthesisExplicit(): boolean {
	return hasExplicitSynthesisConfig(st.agent);
}

function synthesisProviderExplicit(): boolean {
	return hasExplicitSynthesisProvider(st.agent);
}

function synthesisModelPresets() {
	const provider = synthesisProvider();
	return provider ? getModelPresets(provider) : [];
}

let customSynthesisModelActive = $state(false);

function synthesisModelSelectValue(): string {
	if (customSynthesisModelActive) return "__custom__";
	const model = synthesisModel();
	if (!model) return "";
	return synthesisModelPresets().some((preset) => preset.value === model) ? model : "__custom__";
}

function synthesisModelLabel(): string {
	const model = synthesisModel();
	if (!model) return "";
	const preset = synthesisModelPresets().find((entry) => entry.value === model);
	return preset ? preset.label : model;
}

function synthesisProviderRisky(): boolean {
	return providerRisky(synthesisProvider());
}

function synthesisModelNeedsCostWarning(): boolean {
	return modelNeedsCostWarning(synthesisProvider(), synthesisModel());
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
	const currentEndpoint =
		st.aStr(["memory", "pipelineV2", "extractionEndpoint"]) ||
		st.aStr(["memory", "pipelineV2", "extractionBaseUrl"]) ||
		st.aStr(["memory", "pipelineV2", "extraction", "endpoint"]) ||
		st.aStr(["memory", "pipelineV2", "extraction", "base_url"]);
	customModelActive = false;
	st.aSetStr(["memory", "pipelineV2", "extractionProvider"], nextProvider);
	if (!nextProvider) {
		st.aSetStr(["memory", "pipelineV2", "extractionModel"], "");
		return;
	}
	if (nextProvider === "openai-compatible" && !currentEndpoint) {
		st.aSetStr(["memory", "pipelineV2", "extractionEndpoint"], DEFAULT_OPENAI_COMPATIBLE_ENDPOINT);
	}
	if (!currentModel || isKnownPreset(currentModel)) {
		st.aSetStr(["memory", "pipelineV2", "extractionModel"], defaultModelForProvider(nextProvider));
	}
}

function setExtractionModelPreset(v: string | undefined): void {
	if (!v) {
		customModelActive = false;
		st.aSetStr(["memory", "pipelineV2", "extractionModel"], "");
		return;
	}
	if (v === "__custom__") {
		customModelActive = true;
		return;
	}
	customModelActive = false;
	st.aSetStr(["memory", "pipelineV2", "extractionModel"], v);
}

function setSynthesisProvider(v: string | undefined): void {
	const nextProvider = v ?? "";
	customSynthesisModelActive = false;
	st.aSetStr(["memory", "pipelineV2", "synthesis", "provider"], nextProvider);
	st.aSetBool(["memory", "pipelineV2", "synthesis", "enabled"], nextProvider !== "none");
	if (!nextProvider) {
		st.aSetStr(["memory", "pipelineV2", "synthesis", "model"], "");
		return;
	}
	st.aSetStr(["memory", "pipelineV2", "synthesis", "model"], defaultModelForProvider(nextProvider));
}

function setSynthesisModelPreset(v: string | undefined): void {
	if (!v) {
		customSynthesisModelActive = false;
		st.aSetStr(["memory", "pipelineV2", "synthesis", "model"], "");
		return;
	}
	if (v === "__custom__") {
		customSynthesisModelActive = true;
		return;
	}
	customSynthesisModelActive = false;
	st.aSetStr(["memory", "pipelineV2", "synthesis", "model"], v);
}

function extractionModelLabel(): string {
	const model = st.aStr(["memory", "pipelineV2", "extractionModel"]);
	if (!model) return "";
	const preset = extractionModelPresets().find((p) => p.value === model);
	return preset ? preset.label : model;
}

let acpxAgent = $state<AcpxDashboardAgent>("codex");
let acpxModel = $state(defaultAcpxDashboardModel("codex"));

$effect(() => {
	const nextAgent = defaultAcpxDashboardAgent(st.agent);
	acpxAgent = nextAgent;
	const current =
		st.aStr(["memory", "pipelineV2", "extractionProvider"]) === "acpx"
			? st.aStr(["memory", "pipelineV2", "extractionModel"])
			: "";
	acpxModel = current || defaultAcpxDashboardModel(nextAgent);
});

function acpxAgentLabel(): string {
	return ACPX_DASHBOARD_AGENT_OPTIONS.find((option) => option.value === acpxAgent)?.label ?? acpxAgent;
}

function setAcpxAgent(value: string | undefined): void {
	if (value !== "codex" && value !== "claude-code" && value !== "opencode") return;
	acpxAgent = value;
	acpxModel = defaultAcpxDashboardModel(value);
}

function setAcpxModel(e: Event): void {
	acpxModel = (e.currentTarget as HTMLInputElement).value;
}

function applyAcpxQuickSetup(): void {
	applyAcpxDashboardSetup(st.agent, { agent: acpxAgent, model: acpxModel });
	st.agent = { ...st.agent };
}

const STRENGTH_MAX_TOKENS: Record<string, number> = { low: 1024, medium: 2048, high: 4096 };

function strengthMaxTokensLabel(): number {
	const s = st.aStr(["memory", "pipelineV2", "extractionStrength"]) || "low";
	return STRENGTH_MAX_TOKENS[s] ?? 1024;
}

const TOP_LEVEL_FEATURE_KEYS = [
	"allowUpdateDelete",
	"graphEnabled",
	"autonomousEnabled",
	"semanticContradictionEnabled",
] as const;
const ADVANCED_FEATURE_KEYS = ["autonomousFrozen"] as const;
</script>

{#if st.agentFile}
	<FormSection description="V2 memory pipeline. Worker toggles, feature flags, and maintenance controls. Inference provider/model/endpoint configuration moved to the Inference tab.">
		<FormField label={humanizeConfigKey(PIPELINE_CORE_BOOLS[0].key)} description={PIPELINE_CORE_BOOLS[0].desc}>
			<Switch checked={st.aBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[0].key])} onCheckedChange={setBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[0].key])} />
		</FormField>

		{#each PIPELINE_FEATURE_BOOLS.filter(b => TOP_LEVEL_FEATURE_KEYS.includes(b.key as typeof TOP_LEVEL_FEATURE_KEYS[number])) as { key, desc } (key)}
			<FormField label={humanizeConfigKey(key)} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		{#each PIPELINE_RERANKER_BOOLS as { key, desc } (key)}
			<FormField label={humanizeConfigKey(key)} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		<AdvancedSection>
			<FormField label={humanizeConfigKey(PIPELINE_CORE_BOOLS[1].key)} description={PIPELINE_CORE_BOOLS[1].desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[1].key])} onCheckedChange={setBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[1].key])} />
			</FormField>
			<FormField label={humanizeConfigKey(PIPELINE_CORE_BOOLS[2].key)} description={PIPELINE_CORE_BOOLS[2].desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[2].key])} onCheckedChange={setBool(["memory", "pipelineV2", PIPELINE_CORE_BOOLS[2].key])} />
			</FormField>
			{#each PIPELINE_FEATURE_BOOLS.filter(b => ADVANCED_FEATURE_KEYS.includes(b.key as typeof ADVANCED_FEATURE_KEYS[number])) as { key, desc } (key)}
				<FormField label={humanizeConfigKey(key)} description={desc}>
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
						{st.aStr(["memory", "pipelineV2", "maintenanceMode"]) || "None selected"}
					</Select.Trigger>
					<Select.Content class={selectContentClass}>
						<Select.Item class={selectItemClass} value="" label="None selected" />
						<Select.Item class={selectItemClass} value="observe" label="observe" />
						<Select.Item class={selectItemClass} value="execute" label="execute" />
					</Select.Content>
				</Select.Root>
			</FormField>

			{#if st.aBool(["memory", "pipelineV2", "semanticContradictionEnabled"])}
				{#each PIPELINE_CONTRADICTION_NUMS as { key, label, desc, min, max, step } (key)}
					<FormField {label} description={desc}>
						<Input type="number" {min} {max} {step} value={st.aNum(["memory", "pipelineV2", key])} oninput={setNum(["memory", "pipelineV2", key])} />
					</FormField>
				{/each}
			{/if}

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
