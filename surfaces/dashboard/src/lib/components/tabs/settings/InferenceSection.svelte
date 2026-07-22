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

// Aggregation executor options EXCLUDE acpx — aggregate recall is latency-
// sensitive and pi-ai-only (subprocess spawn latency would dominate).
const AGGREGATION_EXECUTOR_OPTIONS = EXECUTOR_OPTIONS.filter((o) => o.value !== "acpx");

function bgExecutor(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "executor"]);
}
function bgSetExecutor(v: string): void {
	writeTarget({ targetName: TARGET_NAME, accountName: ACCOUNT_NAME, workloadKey: "memoryExtraction", executor: v });
}

function providerFamilyForExecutor(exec: string): string {
	if (exec === "anthropic") return "anthropic";
	if (exec === "openrouter") return "openrouter";
	return "openai";
}

// Mirror the router's needsCredential (inference-router.ts): anthropic and
// openrouter always need a credential; openai-compatible needs one only when
// the endpoint is remote; ollama/llama-cpp/acpx never do. isLocalEndpoint is
// inlined here (not imported from @signet/core) because the dashboard is a
// browser bundle and cannot pull core's Node-only runtime (better-sqlite3).
// Keep this in sync with platform/core/src/routing.ts isLocalInferenceEndpoint.
function isLocalEndpoint(endpoint: string): boolean {
	if (!endpoint) return true;
	try {
		return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(endpoint).hostname);
	} catch {
		return false;
	}
}
function targetNeedsAccount(exec: string, endpoint: string): boolean {
	if (exec === "anthropic" || exec === "openrouter") return true;
	if (exec === "openai-compatible") return !isLocalEndpoint(endpoint);
	return false;
}

// Ensure the account has the shape parseAccountConfig accepts: it returns null
// (silently dropping the account) if `kind` or `providerFamily` is absent, which
// would block every API target with "account ... not found".
function ensureAccount(accountName: string, executor: string): void {
	st.aSetStr(["inference", "accounts", accountName, "kind"], "api");
	st.aSetStr(["inference", "accounts", accountName, "providerFamily"], providerFamilyForExecutor(executor));
}

// Write the complete, routing-valid target + account shape for an executor.
// Local/acpx targets get NO account; API targets get a linked account with the
// valid { kind, providerFamily, credentialRef } shape.
function writeTarget(opts: {
	targetName: string;
	accountName: string;
	workloadKey: string;
	executor: string;
}): void {
	const { targetName, accountName, workloadKey, executor } = opts;
	const targetBase = ["inference", "targets", targetName];
	const accountBase = ["inference", "accounts", accountName];
	const workloadBase = ["inference", "workloads", workloadKey];
	if (!executor) {
		// Reset the whole target: clear every field so allTargetRefs (which
		// enumerates via targets.*.models) does not surface an orphaned ref that
		// would block with "account ... not found". aDel prunes empty parents.
		st.aDel([...targetBase, "executor"]);
		st.aDel([...targetBase, "account"]);
		st.aDel([...targetBase, "models"]);
		st.aDel([...targetBase, "endpoint"]);
		st.aDel([...targetBase, "acpx"]);
		st.aDel(accountBase);
		st.aDel(workloadBase);
		return;
	}
	st.aSetStr([...targetBase, "executor"], executor);
	st.aSetStr([...workloadBase, "target"], `${targetName}/default`);
	const endpoint = st.aStr([...targetBase, "endpoint"]);
	if (!targetNeedsAccount(executor, endpoint)) {
		st.aDel([...targetBase, "account"]);
		st.aDel(accountBase);
	} else {
		st.aSetStr([...targetBase, "account"], accountName);
		ensureAccount(accountName, executor);
	}
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
	if (v) ensureAccount(ACCOUNT_NAME, bgExecutor());
}

function bgModelOptions(): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = providerFamilyForExecutor(bgExecutor());
	return (catalog.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}

// ---------------------------------------------------------------------------
// Aggregation (separate latency-optimized path, pi-ai-only — no ACPX).
// Aggregate recall is query-time evidence synthesis; it depends on inference
// speed, not raw intelligence or cost, so it gets its own target bound to the
// aggregate_recall workload. The router enforces no-ACPX at the routing layer.
// ---------------------------------------------------------------------------
const AGG_TARGET_NAME = "aggregation";
const AGG_ACCOUNT_NAME = "aggregation";

function aggExecutor(): string {
	return st.aStr(["inference", "targets", AGG_TARGET_NAME, "executor"]);
}
function aggSetExecutor(v: string): void {
	writeTarget({ targetName: AGG_TARGET_NAME, accountName: AGG_ACCOUNT_NAME, workloadKey: "aggregateRecall", executor: v });
}
function aggModelId(): string {
	return st.aStr(["inference", "targets", AGG_TARGET_NAME, "models", "default", "model"]);
}
function aggSetModelId(v: string): void {
	st.aSetStr(["inference", "targets", AGG_TARGET_NAME, "models", "default", "model"], v);
}
function aggEndpoint(): string {
	return st.aStr(["inference", "targets", AGG_TARGET_NAME, "endpoint"]);
}
function aggSetEndpoint(v: string): void {
	st.aSetStr(["inference", "targets", AGG_TARGET_NAME, "endpoint"], v);
}
function aggApiKey(): string {
	return st.aStr(["inference", "accounts", AGG_ACCOUNT_NAME, "credentialRef"]);
}
function aggSetApiKey(v: string): void {
	st.aSetStr(["inference", "accounts", AGG_ACCOUNT_NAME, "credentialRef"], v);
	if (v) ensureAccount(AGG_ACCOUNT_NAME, aggExecutor());
}
function aggModelOptions(): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = providerFamilyForExecutor(aggExecutor());
	return (catalog.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}
const aggIsLocal = $derived(["openai-compatible", "ollama", "llama-cpp"].includes(aggExecutor()));
const aggNeedsApiKey = $derived(
	aggExecutor() === "anthropic" ||
	aggExecutor() === "openrouter" ||
	(aggExecutor() === "openai-compatible" && !isLocalEndpoint(aggEndpoint())),
);

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
const needsApiKey = $derived(
	bgExecutor() === "anthropic" ||
	bgExecutor() === "openrouter" ||
	(bgExecutor() === "openai-compatible" && !isLocalEndpoint(bgEndpoint())),
);
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
	<!-- Aggregation (separate latency-optimized path, pi-ai-only)    -->
	<!-- ============================================================ -->
	<SettingList title="Aggregation">
		<SettingRow
			title="Backend"
			description="Which backend runs aggregate recall (query-time evidence synthesis). Latency-sensitive and pi-ai-only — ACPX subprocesses are excluded because spawn latency would dominate."
		>
			<Select.Root type="single" value={aggExecutor()} onValueChange={(v) => aggSetExecutor(v)}>
				<Select.Trigger class={selectTriggerClass}>
					{AGGREGATION_EXECUTOR_OPTIONS.find((o) => o.value === aggExecutor())?.label ?? "— none —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each AGGREGATION_EXECUTOR_OPTIONS as opt (opt.value)}
						<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingRow>

		{#if aggExecutor() && aggExecutor() !== ""}
			<SettingRow
				title="Model"
				description="From the pi-ai catalog. Favor a fast/cheap model — aggregation is latency-bound, not intelligence-bound."
			>
				<div class="flex flex-col gap-2 w-full">
					{#if aggModelOptions().length > 0}
						<Select.Root type="single" value={aggModelId()} onValueChange={(v) => aggSetModelId(v)}>
							<Select.Trigger class={selectTriggerClass}>
								{aggModelId() || "— select —"}
							</Select.Trigger>
							<Select.Content class={selectContentClass}>
								<Select.Item class={selectItemClass} value="" label="— select —" />
								{#each aggModelOptions() as opt (opt.value)}
									<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					{/if}
					<Input
						class={inputClass}
						value={aggModelId()}
						placeholder="custom model id"
						oninput={(e) => aggSetModelId(e.currentTarget.value)}
					/>
				</div>
			</SettingRow>

			{#if aggIsLocal}
				<SettingRow
					title="Endpoint"
					description="Base URL of the OpenAI-compatible server."
				>
					<Input
						class={inputClass}
						value={aggEndpoint()}
						placeholder="http://localhost:1234/v1"
						oninput={(e) => aggSetEndpoint(e.currentTarget.value)}
					/>
				</SettingRow>
			{/if}

			{#if aggNeedsApiKey}
				<SettingRow
					title="API key (secret name)"
					description="The Signet secret holding the key."
				>
					<Input
						class={inputClass}
						value={aggApiKey()}
						placeholder="ANTHROPIC_API_KEY"
						oninput={(e) => aggSetApiKey(e.currentTarget.value)}
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
