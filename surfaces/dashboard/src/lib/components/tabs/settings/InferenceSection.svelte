<script lang="ts">
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import FormSection from "$lib/components/config/FormSection.svelte";
import SettingList from "$lib/components/config/SettingList.svelte";
import SettingRow from "$lib/components/config/SettingRow.svelte";
import { type InferenceCatalog, getInferenceCatalog } from "$lib/api";
import { CheckCircle, KeyRound, Plus, TriangleAlertIcon } from "$lib/icons";
import { st } from "$lib/stores/settings.svelte";
import { invalidateAll } from "$app/navigation";
import ConnectProviderDialog from "./ConnectProviderDialog.svelte";

// Inference settings (#947/#966/#968). A provider connect wall sits above the
// target pickers: connect Claude Max / ChatGPT / Copilot via OAuth, or any API
// provider via a pasted key (stored encrypted, never surfaced as a "secret
// name"). Background + aggregation targets then draw from connected providers.

const selectTriggerClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg max-h-[320px]";
const selectItemClass = "font-mono text-[11px] rounded-lg";
const inputClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";

// pi-ai catalog (providers + OAuth providers + models)
let catalog = $state<InferenceCatalog | null>(null);
let catalogFailed = $state(false);
// Defensive: a daemon predating #968 omits oauthProviders/modelErrors. Default
// them so an older runtime doesn't break the panel — it just shows fewer cards.
async function loadCatalog(): Promise<InferenceCatalog | null> {
	try {
		const c = await getInferenceCatalog();
		catalogFailed = false;
		return {
			providers: c.providers ?? [],
			models: c.models ?? {},
			modelErrors: c.modelErrors ?? {},
			oauthProviders: c.oauthProviders ?? [],
			acpxAgents: c.acpxAgents ?? [],
		};
	} catch {
		catalogFailed = true;
		return null;
	}
}
$effect(() => {
	void loadCatalog().then((c) => (catalog = c));
});

// ---------------------------------------------------------------------------
// Provider connect wall
// ---------------------------------------------------------------------------
// OAuth-only subscription providers (no direct API key path). pi-ai reaches
// these only through their OAuth login.
const OAUTH_ONLY_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

// Friendly names for known provider families. Anything not listed falls back to
// a title-cased id. The wall is built from the LIVE catalog, not this list, so a
// provider added upstream (e.g. zai, kimi-coding) shows up without a dashboard
// change — this map only controls display name + ordering.
const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic (Claude)",
	"openai-codex": "ChatGPT / Codex",
	"github-copilot": "GitHub Copilot",
	openrouter: "OpenRouter",
	openai: "OpenAI",
	google: "Google (Gemini)",
	xai: "xAI (Grok)",
	groq: "Groq",
	mistral: "Mistral",
	deepseek: "DeepSeek",
	zai: "ZAI",
	"zai-coding-cn": "ZAI Coding (CN)",
};
// Known providers float to the top in this order; everything else sorts after.
const FEATURED_ORDER = [
	"anthropic",
	"openai-codex",
	"github-copilot",
	"openrouter",
	"openai",
	"google",
	"xai",
	"groq",
	"mistral",
	"deepseek",
	"zai",
	"zai-coding-cn",
];

interface ConnectableProvider {
	id: string;
	name: string;
	supportsOAuth: boolean;
	supportsApiKey: boolean;
	connected: boolean;
	isOAuth: boolean;
}

let connecting = $state<{ provider: ConnectableProvider } | null>(null);

function titleCase(id: string): string {
	return id
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function connectableProviders(): ConnectableProvider[] {
	if (!catalog) return [];
	const cat = catalog;
	const oauthIds = new Set(cat.oauthProviders.map((p) => p.id));
	const oauthStatus = new Map(cat.oauthProviders.map((p) => [p.id, p] as const));
	// Every provider the catalog knows about is connectable — no hand-picked allowlist.
	// A provider is "connectable" if it's in the model catalog OR it's an OAuth provider.
	const allIds = new Set<string>([...cat.providers, ...oauthIds]);
	const sortedIds = [...allIds].sort((a, b) => {
		const ia = FEATURED_ORDER.indexOf(a);
		const ib = FEATURED_ORDER.indexOf(b);
		if (ia !== -1 && ib !== -1) return ia - ib;
		if (ia !== -1) return -1;
		if (ib !== -1) return 1;
		return a.localeCompare(b);
	});
	return sortedIds.map((id) => {
		const supportsOAuth = oauthIds.has(id);
		const isOAuthOnly = OAUTH_ONLY_PROVIDERS.has(id);
		// API-key path needs model entries (the catalog maps provider→models).
		const supportsApiKey = cat.providers.includes(id) && !isOAuthOnly;
		const connected = supportsOAuth
			? (oauthStatus.get(id)?.connected ?? false) || hasApiKeyAccount(id)
			: hasApiKeyAccount(id);
		return {
			id,
			name: PROVIDER_NAMES[id] ?? titleCase(id),
			supportsOAuth,
			supportsApiKey,
			connected,
			isOAuth: supportsOAuth,
		};
	});
}

function hasApiKeyAccount(providerFamily: string): boolean {
	return !!st.aStr(["inference", "accounts", providerFamily, "credentialRef"]);
}

function openConnect(provider: ConnectableProvider): void {
	connecting = { provider };
}

function closeConnect(): void {
	connecting = null;
}

// After a connect/disconnect, persist any config writes (account entries are
// in-memory until st.save()), then re-read the catalog + refresh. Order matters:
// save() writes agent.yaml, then invalidateAll() re-reads it — so the account
// wiring survives the refresh instead of being clobbered by st.init() from disk.
async function onProviderChanged(): Promise<void> {
	if (st.isDirty) await st.save();
	catalog = await loadCatalog();
	try {
		await invalidateAll();
	} catch {
		/* navigation may not be ready in all contexts */
	}
}

// ---------------------------------------------------------------------------
// Background / aggregation target helpers (unchanged logic)
// ---------------------------------------------------------------------------
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

// Executors that REQUIRE an API key / account to function at all.
function executorRequiresAccount(exec: string): boolean {
	return exec === "anthropic" || exec === "openrouter";
}
// openai-compatible MAY take an optional key (local servers are keyless by
// default; remote gateways may want one but it's not enforced).
function executorAllowsOptionalKey(exec: string): boolean {
	return exec === "openai-compatible";
}

// Conventional secret name for a provider family (used only as the placeholder
// hint — never hardcode ANTHROPIC_API_KEY for every provider).
function secretNameFor(exec: string): string {
	const family = providerFamilyForExecutor(exec);
	return `${family.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

function ensureAccount(accountName: string, executor: string): void {
	st.aSetStr(["inference", "accounts", accountName, "kind"], "api");
	st.aSetStr(["inference", "accounts", accountName, "providerFamily"], providerFamilyForExecutor(executor));
}

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
	const hasKey = !!st.aStr([...accountBase, "credentialRef"]);
	// Account linkage rule:
	//  - anthropic/openrouter: always need an account (key required).
	//  - openai-compatible: link an account only when a key is present (optional
	//    key — keyless local servers stay account-free).
	//  - ollama/llama-cpp/acpx: never need an account — drop it even if a stale
	//    key lingers from a prior executor, so a key isn't injected into a
	//    keyless provider. executorAllowsOptionalKey gates the keep-on-hasKey
	//    behavior so only the optional-key executor honors a leftover key.
	const needsAccount = executorRequiresAccount(executor) || (executorAllowsOptionalKey(executor) && hasKey);
	if (!needsAccount) {
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
	const targetBase = ["inference", "targets", TARGET_NAME];
	const accountBase = ["inference", "accounts", ACCOUNT_NAME];
	st.aSetStr([...accountBase, "credentialRef"], v);
	if (v) {
		// A key was provided: ensure the account shape + link it to the target
		// (even for local openai-compatible, which is otherwise keyless).
		ensureAccount(ACCOUNT_NAME, bgExecutor());
		st.aSetStr([...targetBase, "account"], ACCOUNT_NAME);
	} else if (bgExecutor() === "openai-compatible") {
		// Optional key removed on a keyless-capable executor: drop the account.
		st.aDel([...targetBase, "account"]);
		st.aDel(accountBase);
	}
}

function bgModelOptions(): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = providerFamilyForExecutor(bgExecutor());
	return (catalog.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}

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
	const targetBase = ["inference", "targets", AGG_TARGET_NAME];
	const accountBase = ["inference", "accounts", AGG_ACCOUNT_NAME];
	st.aSetStr([...accountBase, "credentialRef"], v);
	if (v) {
		ensureAccount(AGG_ACCOUNT_NAME, aggExecutor());
		st.aSetStr([...targetBase, "account"], AGG_ACCOUNT_NAME);
	} else if (aggExecutor() === "openai-compatible") {
		st.aDel([...targetBase, "account"]);
		st.aDel(accountBase);
	}
}
function aggModelOptions(): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = providerFamilyForExecutor(aggExecutor());
	return (catalog.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}
const aggIsLocal = $derived(["openai-compatible", "ollama", "llama-cpp"].includes(aggExecutor()));
// #3: openai-compatible aggregation shows an OPTIONAL key field always (local
// servers stay keyless, but the field is there for gateways that need auth).
const aggNeedsApiKey = $derived(
	aggExecutor() === "anthropic" ||
	aggExecutor() === "openrouter" ||
	aggExecutor() === "openai-compatible",
);

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
// #3: openai-compatible background also shows an optional key field always.
const needsApiKey = $derived(
	bgExecutor() === "anthropic" ||
	bgExecutor() === "openrouter" ||
	bgExecutor() === "openai-compatible",
);
const embNonNative = $derived(embProvider() && embProvider() !== "native" && embProvider() !== "");
</script>

<FormSection description="Connect AI providers, then choose which one runs background memory work. Connect once; keys live encrypted and never leave the daemon.">

	<!-- ============================================================ -->
	<!-- Provider connect wall                                         -->
	<!-- ============================================================ -->
	<SettingList title="Providers">
		<div class="provider-grid">
			{#each connectableProviders() as provider (provider.id)}
				<button
					class="provider-card {provider.connected ? "provider-card--connected" : ""}"
					onclick={() => openConnect(provider)}
				>
					<div class="provider-card-head">
						<span class="provider-name">{provider.name}</span>
						{#if provider.connected}
							<span class="status-badge status-badge--ok"><CheckCircle class="size-3" /> Connected</span>
						{:else}
							<span class="status-badge status-badge--off"><Plus class="size-3" /> Connect</span>
						{/if}
					</div>
					<div class="provider-card-meta">
						{#if provider.supportsOAuth && provider.supportsApiKey}
							<span class="meta-pill">Sign in or API key</span>
						{:else if provider.supportsOAuth}
							<span class="meta-pill"><KeyRound class="size-2.5" /> Sign in</span>
						{:else}
							<span class="meta-pill"><KeyRound class="size-2.5" /> API key</span>
						{/if}
						{#if catalog?.models[provider.id]?.length}
							<span class="meta-count">{catalog.models[provider.id].length} models</span>
						{/if}
					</div>
				</button>
			{:else}
				{#if catalogFailed}
					<div class="provider-empty">Couldn't load the provider catalog. Update the daemon and retry.</div>
				{:else}
					<div class="provider-empty">Loading providers…</div>
				{/if}
			{/each}
		</div>
		{#if catalog?.modelErrors && Object.keys(catalog.modelErrors).length > 0}
			<div class="catalog-warnings">
				{#each Object.entries(catalog.modelErrors) as [providerId, message] (providerId)}
					<div class="catalog-warning">
						<TriangleAlertIcon class="size-3" />
						<span>{providerId}: {message}</span>
					</div>
				{/each}
			</div>
		{/if}
	</SettingList>

	<!-- ============================================================ -->
	<!-- Background executor + model + endpoint + key                  -->
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
				description="The Signet secret holding the key. Or connect via the Providers panel above to skip this. The key value is never shown."
				>
					<Input
						class={inputClass}
						value={bgApiKey()}
						placeholder={secretNameFor(bgExecutor())}
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
						placeholder={secretNameFor(aggExecutor())}
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

{#if connecting}
	<ConnectProviderDialog
		provider={connecting.provider}
		supportsOAuth={connecting.provider.supportsOAuth}
		supportsApiKey={connecting.provider.supportsApiKey}
		onclose={closeConnect}
		onsaved={() => onProviderChanged()}
	/>
{/if}

<style>
	:global(.setting-list-wrap + .setting-list-wrap) {
		margin-top: var(--space-lg);
	}
	.provider-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 10px;
		width: 100%;
	}
	.provider-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 11px 12px;
		border: 1px solid var(--sig-border);
		border-radius: 9px;
		background: var(--sig-bg);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.12s, background 0.12s;
	}
	.provider-card:hover {
		border-color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}
	.provider-card--connected {
		border-color: rgba(74, 222, 128, 0.35);
	}
	.provider-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.provider-name {
		font-family: var(--font-body);
		font-size: 12px;
		font-weight: 600;
		color: var(--sig-text);
	}
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-body);
		font-size: 9.5px;
		font-weight: 500;
		padding: 2px 6px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.status-badge--ok {
		color: #4ade80;
		background: rgba(74, 222, 128, 0.12);
	}
	.status-badge--off {
		color: var(--sig-text-muted);
		background: var(--sig-surface-raised);
	}
	.provider-card-meta {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.meta-pill {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-body);
		font-size: 9.5px;
		color: var(--sig-text-muted);
	}
	.meta-count {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--sig-text-muted);
		opacity: 0.7;
	}
	.provider-empty {
		font-family: var(--font-body);
		font-size: 11px;
		color: var(--sig-text-muted);
		padding: 12px;
		grid-column: 1 / -1;
	}
	.catalog-warnings {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 4px;
	}
	.catalog-warning {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-body);
		font-size: 10.5px;
		color: #fbbf24;
	}
</style>
