<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { type InferenceCatalog, getInferenceCatalog } from "$lib/api";
import { st } from "$lib/stores/settings.svelte";

// Inference settings (#947). Unified editable form — no sub-tabs. Everything
// here is click-through-able and writes to config via the store. Mirrors the
// interactive patterns in PipelineSection/EmbeddingsSection (shadcn Select +
// Input bound to st.sStr/sSetStr and st.aStr/aSetStr).
//
// Two concerns, both editable:
//   1. Extraction / background LLM — which provider + model + endpoint runs
//      background memory work. Writes inference.* (routing registry).
//   2. Embeddings — provider + model + endpoint for the vector store. Writes
//      the existing embedding.* paths (folded in from the old Embeddings tab).

const selectTriggerClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg max-h-[320px]";
const selectItemClass = "font-mono text-[11px] rounded-lg";
const inputClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";

// ---------------------------------------------------------------------------
// pi-ai catalog (providers + models). Powers the dropdowns.
// ---------------------------------------------------------------------------
let catalog = $state<InferenceCatalog | null>(null);
let catalogError = $state<string | null>(null);

async function loadCatalog(): Promise<void> {
	try {
		catalog = await getInferenceCatalog();
		catalogError = null;
	} catch (e) {
		catalogError = e instanceof Error ? e.message : String(e);
	}
}
$effect(() => {
	void loadCatalog();
});

// ---------------------------------------------------------------------------
// Extraction / background target.
// Writes the registry: inference.targets.<id> + inference.accounts.<id>.
// For the dashboard simple-flow we edit a single "background" target.
// ---------------------------------------------------------------------------
const TARGET_NAME = "background";

// The executor (backend kind) for the background target. The set of executors
// that still exist after the #947 cutover.
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

// Read/write helpers over the registry, scoped to the background target.
function bgExecutor(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "executor"]);
}
function bgSetExecutor(v: string): void {
	if (!v) {
		// Clearing: remove the target entirely.
		st.aSetStr(["inference", "targets", TARGET_NAME, "executor"], "");
		return;
	}
	st.aSetStr(["inference", "targets", TARGET_NAME, "executor"], v);
}

// For openai-compatible/ollama/llama-cpp/anthropic/openrouter: which provider
// family the catalog models come from (drives the model dropdown).
function providerFamilyForExecutor(exec: string): string {
	if (exec === "anthropic") return "anthropic";
	if (exec === "openrouter") return "openrouter";
	// openai-compatible / ollama / llama-cpp all surface as openai-compat models
	// in the pi-ai catalog; the actual model id is user-entered for local servers.
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

// API key for the background target's account. Stored under inference.accounts.
const ACCOUNT_NAME = "background";
function bgApiKey(): string {
	return st.aStr(["inference", "accounts", ACCOUNT_NAME, "credentialRef"]);
}
function bgSetApiKey(v: string): void {
	// credentialRef is a secret NAME (e.g. ANTHROPIC_API_KEY), not the key value.
	st.aSetStr(["inference", "accounts", ACCOUNT_NAME, "credentialRef"], v);
}

// Models available for the chosen provider family, from the catalog.
function bgModelOptions(): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = providerFamilyForExecutor(bgExecutor());
	const list = catalog.models[family] ?? [];
	return list.map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}

// ---------------------------------------------------------------------------
// Embeddings (folded in from the old Embeddings tab).
// ---------------------------------------------------------------------------
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
</script>

<FormSection
	description="Inference backends after the #947 cutover. Pick the provider + model that runs background memory work, and configure embeddings. Everything here is editable and saves with the Save bar."
>
	{#if catalogError}
		<div class="catalog-error">
			Could not load the model catalog from the daemon ({catalogError}). Model dropdowns will be
			empty until a daemon built from this branch is running.
		</div>
	{/if}

	<!-- =========================================================== -->
	<!-- Extraction / background LLM -->
	<!-- =========================================================== -->
	<FormField
		label="Background executor"
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
	</FormField>

	{#if bgExecutor() && bgExecutor() !== ""}
		<!-- Model picker (catalog-backed dropdown) -->
		{#if bgExecutor() === "acpx"}
			<FormField label="ACPX agent" description="The harness ACPX drives.">
				<Select.Root type="single" value={bgAcpxAgent()} onValueChange={(v) => bgSetAcpxAgent(v)}>
					<Select.Trigger class={selectTriggerClass}>{bgAcpxAgent()}</Select.Trigger>
					<Select.Content class={selectContentClass}>
						{#each ACPX_AGENTS as agent (agent)}
							<Select.Item class={selectItemClass} value={agent} label={agent} />
						{/each}
					</Select.Content>
				</Select.Root>
			</FormField>
		{:else}
			<FormField
				label="Model"
				description="From the pi-ai catalog. For local OpenAI-compatible servers, type the model id your server exposes."
			>
				<div class="flex flex-col gap-2">
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
			</FormField>
		{/if}

		<!-- Endpoint (openai-compatible / ollama / llama-cpp) -->
		{#if ["openai-compatible", "ollama", "llama-cpp"].includes(bgExecutor())}
			<FormField
				label="Endpoint"
				description="Base URL of the OpenAI-compatible server. LM Studio default: http://localhost:1234/v1 · Ollama: http://localhost:11434 · llama.cpp: http://localhost:8080/v1"
			>
				<Input
					class={inputClass}
					value={bgEndpoint()}
					placeholder="http://localhost:1234/v1"
					oninput={(e) => bgSetEndpoint(e.currentTarget.value)}
				/>
			</FormField>
		{/if}

		<!-- API key (anthropic / openrouter / remote openai-compatible) -->
		{#if ["anthropic", "openrouter"].includes(bgExecutor())}
			<FormField
				label="API key (secret name)"
				description="The name of the Signet secret holding the key, e.g. ANTHROPIC_API_KEY or OPENROUTER_API_KEY. The key value is never shown."
			>
				<Input
					class={inputClass}
					value={bgApiKey()}
					placeholder="ANTHROPIC_API_KEY"
					oninput={(e) => bgSetApiKey(e.currentTarget.value)}
				/>
			</FormField>
		{/if}
	{/if}

	<!-- =========================================================== -->
	<!-- Embeddings (folded in) -->
	<!-- =========================================================== -->
	<div class="section-divider">Embeddings</div>

	<FormField
		label="Embedding provider"
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
	</FormField>

	{#if embProvider() && embProvider() !== "native" && embProvider() !== ""}
		<FormField label="Embedding model" description="The model id your embedding provider exposes.">
			<Input
				class={inputClass}
				value={embModel()}
				placeholder="nomic-embed-text"
				oninput={(e) => embSetModel(e.currentTarget.value)}
			/>
		</FormField>
		<FormField label="Embedding endpoint" description="Base URL of the embedding server.">
			<Input
				class={inputClass}
				value={embEndpoint()}
				placeholder="http://localhost:11434"
				oninput={(e) => embSetEndpoint(e.currentTarget.value)}
			/>
		</FormField>
	{/if}
</FormSection>

<style>
	.section-divider {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		margin-top: var(--space-md);
		padding-top: var(--space-md);
		border-top: 1px solid var(--sig-border);
	}
	.catalog-error {
		font-family: var(--font-body);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-warning, #d4a017);
		background: color-mix(in srgb, var(--sig-warning, #d4a017) 10%, transparent);
		border: 1px solid var(--sig-warning, #d4a017);
		padding: 8px 10px;
		border-radius: 6px;
		margin-bottom: var(--space-md);
	}
</style>
