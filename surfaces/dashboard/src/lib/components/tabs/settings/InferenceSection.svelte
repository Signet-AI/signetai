<script lang="ts">
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import FormSection from "$lib/components/config/FormSection.svelte";
import SettingList from "$lib/components/config/SettingList.svelte";
import SettingRow from "$lib/components/config/SettingRow.svelte";
import { type InferenceCatalog, getInferenceCatalog } from "$lib/api";
import { st } from "$lib/stores/settings.svelte";

// Inference settings (#947). Rebuilt to match the OpenCode settings-v2 rhythm:
// SettingList containers with SettingRows (title+description left, control
// right). Three concerns, each its own list:
//   1. Background executor — which backend runs Pipeline V2 extraction.
//   2. Model — which model that executor uses.
//   3. Embeddings — provider/model/endpoint for the vector store.
//
// Writes the routing registry (inference.*) so Pipeline V2 reads it directly,
// plus the workload binding (inference.workloads.memoryExtraction.target).

const selectTriggerClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg max-h-[320px]";
const selectItemClass = "font-mono text-[11px] rounded-lg";
const inputClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";

// pi-ai catalog
let catalog = $state<InferenceCatalog | null>(null);
$effect(() => {
	void getInferenceCatalog().then(
		(c) => (catalog = c),
		() => (catalog = null),
	);
});

const TARGET_NAME = "background";
const ACCOUNT_NAME = "background";

const EXECUTOR_OPTIONS = [
	{ value: "", label: "— none —" },
	{ value: "openai-compatible", label: "OpenAI-compatible (LM Studio / Ollama / gateway)" },
	{ value: "anthropic", label: "Anthropic (direct API)" },
	{ value: "openrouter", label: "OpenRouter" },
	{ value: "ollama", label: "Ollama (local)" },
	{ value: "llama-cpp", label: "llama.cpp (local)" },
	{ value: "acpx", label: "ACPX (harness: Claude / Codex / OpenCode)" },
] as const;

const ACPX_AGENTS = ["claude", "codex", "opencode", "gemini", "pi", "openclaw"];

function bgExecutor(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "executor"]);
}
function bgSetExecutor(v: string): void {
	if (!v) {
		st.aSetStr(["inference", "targets", TARGET_NAME, "executor"], "");
		st.aSetStr(["inference", "workloads", "memoryExtraction", "target"], "");
		return;
	}
	st.aSetStr(["inference", "targets", TARGET_NAME, "executor"], v);
	st.aSetStr(["inference", "workloads", "memoryExtraction", "target"], `${TARGET_NAME}/default`);
}

function providerFamilyForExecutor(exec: string): string {
	if (exec === "anthropic") return "anthropic";
	if (exec === "openrouter") return "openrouter";
	return "openai";
}

function bgModelId(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "models", "default", "model"]);
}
function bgSetModelId(v: string): void {
	st.aSetStr(["inference", "targets", TARGET_NAME, "models", "default", "model"], v);
}

function bgEndpoint(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "endpoint"]);
}
function bgSetEndpoint(v: string): void {
	st.aSetStr(["inference", "targets", TARGET_NAME, "endpoint"], v);
}

function bgAcpxAgent(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "acpx", "agent"]) || "claude";
}
function bgSetAcpxAgent(v: string): void {
	st.aSetStr(["inference", "targets", TARGET_NAME, "acpx", "agent"], v);
}

function bgApiKey(): string {
	return st.aStr(["inference", "accounts", ACCOUNT_NAME, "credentialRef"]);
}
function bgSetApiKey(v: string): void {
	st.aSetStr(["inference", "accounts", ACCOUNT_NAME, "credentialRef"], v);
}

function bgModelOptions(): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = providerFamilyForExecutor(bgExecutor());
	return (catalog.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}

// Embeddings (folded in)
const EMBEDDING_PROVIDER_OPTIONS = [
	{ value: "", label: "— select —" },
	{ value: "native", label: "native (built-in nomic)" },
	{ value: "ollama", label: "ollama" },
	{ value: "openai", label: "openai" },
	{ value: "llama-cpp", label: "llama.cpp" },
] as const;

function embPath(): string[] {
	return st.embPath();
}
function embProvider(): string {
	return st.sStr([...embPath(), "provider"]);
}
function embSetProvider(v: string): void {
	st.sSetStr([...embPath(), "provider"], v);
}
function embModel(): string {
	return st.sStr([...embPath(), "model"]);
}
function embSetModel(v: string): void {
	st.sSetStr([...embPath(), "model"], v);
}
function embEndpoint(): string {
	return st.sStr([...embPath(), "baseUrl"]) || st.sStr([...embPath(), "endpoint"]);
}
function embSetEndpoint(v: string): void {
	st.sSetStr([...embPath(), "baseUrl"], v);
}

const isLocalExecutor = $derived(["openai-compatible", "ollama", "llama-cpp"].includes(bgExecutor()));
const needsApiKey = $derived(["anthropic", "openrouter"].includes(bgExecutor()));
const embNonNative = $derived(embProvider() && embProvider() !== "native" && embProvider() !== "");
</script>

<FormSection description="Inference backends. Pick the backend + model that runs background memory work, and configure embeddings. Everything here saves with the Save bar.">
	<!-- ============================================================ -->
	<!-- Background executor + model + endpoint + key                 -->
	<!-- ============================================================ -->
	<SettingList title="Background inference">
		<SettingRow
			title="Backend"
			description="Which backend runs memory extraction and synthesis. Direct API providers (Anthropic/OpenRouter) are powered by pi-ai; local servers (LM Studio/Ollama/llama.cpp) connect via an OpenAI-compatible endpoint; ACPX drives a harness subprocess (Claude/Codex/OpenCode)."
		>
			<Select.Root type="single" value={bgExecutor()} onValueChange={(v) => bgSetExecutor(v)}>
				<Select.Trigger class={selectTriggerClass}>
					{EXECUTOR_OPTIONS.find((o) => o.value === bgExecutor())?.label ?? "— none —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each EXECUTOR_OPTIONS as opt (opt.value)}
						<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingRow>

		{#if bgExecutor() && bgExecutor() !== ""}
			{#if bgExecutor() === "acpx"}
				<SettingRow title="ACPX agent" description="The harness ACPX drives.">
					<Select.Root type="single" value={bgAcpxAgent()} onValueChange={(v) => bgSetAcpxAgent(v)}>
						<Select.Trigger class={selectTriggerClass}>{bgAcpxAgent()}</Select.Trigger>
						<Select.Content class={selectContentClass}>
							{#each ACPX_AGENTS as agent (agent)}
								<Select.Item class={selectItemClass} value={agent} label={agent} />
							{/each}
						</Select.Content>
					</Select.Root>
				</SettingRow>
			{:else}
				<SettingRow
					title="Model"
					description="From the pi-ai catalog. For local servers, type the model id your server exposes."
				>
					<div class="flex flex-col gap-2 w-full">
						{#if bgModelOptions().length > 0}
							<Select.Root type="single" value={bgModelId()} onValueChange={(v) => bgSetModelId(v)}>
								<Select.Trigger class={selectTriggerClass}>
									{bgModelId() || "— select —"}
								</Select.Trigger>
								<Select.Content class={selectContentClass}>
									<Select.Item class={selectItemClass} value="" label="— select —" />
									{#each bgModelOptions() as opt (opt.value)}
										<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
									{/each}
								</Select.Content>
							</Select.Root>
						{/if}
						<Input
							class={inputClass}
							value={bgModelId()}
							placeholder="custom model id"
							oninput={(e) => bgSetModelId(e.currentTarget.value)}
						/>
					</div>
				</SettingRow>
			{/if}

			{#if isLocalExecutor}
				<SettingRow
					title="Endpoint"
					description="Base URL of the OpenAI-compatible server. LM Studio: http://localhost:1234/v1 · Ollama: http://localhost:11434 · llama.cpp: http://localhost:8080/v1"
				>
					<Input
						class={inputClass}
						value={bgEndpoint()}
						placeholder="http://localhost:1234/v1"
						oninput={(e) => bgSetEndpoint(e.currentTarget.value)}
					/>
				</SettingRow>
			{/if}

			{#if needsApiKey}
				<SettingRow
					title="API key (secret name)"
					description="The Signet secret holding the key, e.g. ANTHROPIC_API_KEY. The key value is never shown."
				>
					<Input
						class={inputClass}
						value={bgApiKey()}
						placeholder="ANTHROPIC_API_KEY"
						oninput={(e) => bgSetApiKey(e.currentTarget.value)}
					/>
				</SettingRow>
			{/if}
		{/if}
	</SettingList>

	<!-- ============================================================ -->
	<!-- Embeddings                                                   -->
	<!-- ============================================================ -->
	<SettingList title="Embeddings">
		<SettingRow
			title="Provider"
			description="Changing provider or model will re-embed your entire memory database."
		>
			<Select.Root type="single" value={embProvider()} onValueChange={(v) => embSetProvider(v)}>
				<Select.Trigger class={selectTriggerClass}>
					{EMBEDDING_PROVIDER_OPTIONS.find((o) => o.value === embProvider())?.label ?? "— select —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each EMBEDDING_PROVIDER_OPTIONS as opt (opt.value)}
						<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingRow>

		{#if embNonNative}
			<SettingRow title="Model" description="The model id your embedding provider exposes.">
				<Input
					class={inputClass}
					value={embModel()}
					placeholder="nomic-embed-text"
					oninput={(e) => embSetModel(e.currentTarget.value)}
				/>
			</SettingRow>
			<SettingRow title="Endpoint" description="Base URL of the embedding server.">
				<Input
					class={inputClass}
					value={embEndpoint()}
					placeholder="http://localhost:11434"
					oninput={(e) => embSetEndpoint(e.currentTarget.value)}
				/>
			</SettingRow>
		{/if}
	</SettingList>
</FormSection>

<style>
	:global(.setting-list-wrap + .setting-list-wrap) {
		margin-top: var(--space-lg);
	}
</style>
