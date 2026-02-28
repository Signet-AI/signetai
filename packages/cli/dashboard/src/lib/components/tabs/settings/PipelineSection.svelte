<script lang="ts">
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

const selectTriggerClass =
	"font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-none w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-none";
const selectItemClass = "font-[family-name:var(--font-mono)] text-[11px] rounded-none";

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
</script>

{#if st.agentFile}
	<FormSection title="Pipeline" defaultOpen={false} description="V2 memory pipeline. Runs LLM-based fact extraction on incoming memories, then decides whether to write, update, or skip. Lives under memory.pipelineV2 in agent.yaml.">
		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Core
		</div>
		{#each PIPELINE_CORE_BOOLS as { key, desc } (key)}
			<FormField label={key} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		<FormField label="Extraction provider" description="LLM backend for fact extraction. Ollama runs locally; claude-code uses Claude Code CLI; opencode uses the OpenCode HTTP server.">
			<Select.Root
				type="single"
				value={st.aStr(["memory", "pipelineV2", "extractionProvider"])}
				onValueChange={setSelect(["memory", "pipelineV2", "extractionProvider"])}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.aStr(["memory", "pipelineV2", "extractionProvider"]) || "\u2014 select \u2014"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="\u2014 select \u2014" />
					<Select.Item class={selectItemClass} value="ollama" label="ollama" />
					<Select.Item class={selectItemClass} value="claude-code" label="claude-code" />
					<Select.Item class={selectItemClass} value="opencode" label="opencode" />
				</Select.Content>
			</Select.Root>
		</FormField>
		<FormField label="Extraction model" description="Model name for fact extraction. Must be available locally via Ollama. Default: qwen3:4b.">
			<Input value={st.aStr(["memory", "pipelineV2", "extractionModel"])} oninput={setStr(["memory", "pipelineV2", "extractionModel"])} />
		</FormField>
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

		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Features
		</div>
		{#each PIPELINE_FEATURE_BOOLS as { key, desc } (key)}
			<FormField label={key} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Reranker
		</div>
		{#each PIPELINE_RERANKER_BOOLS as { key, desc } (key)}
			<FormField label={key} description={desc}>
				<Switch checked={st.aBool(["memory", "pipelineV2", key])} onCheckedChange={setBool(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		{#each PIPELINE_SEARCH_NUMS as { key, label, desc, min, max, step } (key)}
			<FormField {label} description={desc}>
				<Input type="number" {min} {max} {step} value={st.aNum(["memory", "pipelineV2", key])} oninput={setNum(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

		<div class="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.08em] uppercase text-[var(--sig-text-muted)] pt-3 pb-1 border-b border-[var(--sig-border)] mb-1">
			Worker
		</div>
		{#each PIPELINE_WORKER_NUMS as { key, label, desc, min, max, step } (key)}
			<FormField {label} description={desc}>
				<Input type="number" {min} {max} {step} value={st.aNum(["memory", "pipelineV2", key])} oninput={setNum(["memory", "pipelineV2", key])} />
			</FormField>
		{/each}

	</FormSection>
{/if}