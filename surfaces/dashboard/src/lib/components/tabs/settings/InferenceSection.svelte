<script lang="ts">
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import FormSection from "$lib/components/config/FormSection.svelte";
import SettingList from "$lib/components/config/SettingList.svelte";
import SettingRow from "$lib/components/config/SettingRow.svelte";
import { type InferenceCatalog, getInferenceCatalog } from "$lib/api";
import { CheckCircle, Plus, TriangleAlertIcon } from "$lib/icons";
import { st } from "$lib/stores/settings.svelte";
import { invalidateAll } from "$app/navigation";
import { extractionLabelForRoutingTarget } from "./pipeline-settings";
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
let showPicker = $state(false);

// Picker modal focus management: autofocus into the panel on open, restore
// focus to the Add button on close, and listen for Escape at window level (a
// backdrop-only listener misses when focus is outside the modal subtree).
let pickerCloseBtn: HTMLButtonElement | null = $state(null);
let lastFocused: HTMLElement | null = null;

$effect(() => {
	if (!showPicker) return;
	lastFocused = document.activeElement as HTMLElement | null;
	// Defer until the panel renders.
	const id = requestAnimationFrame(() => pickerCloseBtn?.focus());
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			showPicker = false;
		}
	};
	window.addEventListener("keydown", onKey);
	return () => {
		cancelAnimationFrame(id);
		window.removeEventListener("keydown", onKey);
		lastFocused?.focus?.();
	};
});

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
	return isProviderConnected(providerFamily);
}

// Accounts aren't always named after their provider family (e.g. a legacy
// `openrouter-api` account backs the `openrouter` family), so detection and
// backend linking must scan accounts by providerFamily, not by literal name.
function accountsObj(): Record<string, { kind?: string; providerFamily?: string; credentialRef?: string }> {
	const v = st.get(st.agent, "inference", "accounts");
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, { kind?: string; providerFamily?: string; credentialRef?: string }>)
		: {};
}

// True if any account backs this provider family with usable credentials
// (api with a credentialRef, or an OAuth subscription_session).
function isProviderConnected(family: string): boolean {
	for (const a of Object.values(accountsObj())) {
		if (a.providerFamily !== family) continue;
		if (a.kind === "subscription_session") return true;
		if (a.kind === "api" && a.credentialRef) return true;
	}
	return false;
}

// Pick the account name to reference when a target uses this provider family.
// Prefer an account literally named after the family (the connect wall's
// convention), else the first account with that family.
function accountForFamily(family: string): string | null {
	const accts = accountsObj();
	const names = Object.keys(accts).filter((n) => accts[n].providerFamily === family);
	if (names.length === 0) return null;
	return names.includes(family) ? family : names[0];
}

function openConnect(provider: ConnectableProvider): void {
	showPicker = false;
	connecting = { provider };
}

function closeConnect(): void {
	connecting = null;
}

// Connected providers shown in the compact list; the rest are reachable via
// the "+ Add provider" picker so the section doesn't balloon to 30+ rows.
function connectedList(): ConnectableProvider[] {
	return connectableProviders().filter((p) => p.connected);
}
function availableList(): ConnectableProvider[] {
	return connectableProviders().filter((p) => !p.connected);
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

const ACPX_AGENTS = ["claude", "codex", "opencode", "gemini", "pi", "openclaw"];

function bgExecutor(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "executor"]);
}
function bgSetExecutor(v: string): void {
	writeTarget({ targetName: TARGET_NAME, accountName: ACCOUNT_NAME, workloadKey: "memoryExtraction", executor: v });
	syncExtractionLabel();
}

// Backend taxonomy. After #947/#968 the daemon accepts any catalog provider
// family as an executor (the allowlist is a regex now), so a connected
// provider can run background/aggregation work directly. The backend picker
// is driven by (a) connected providers and (b) the local + ACPX executors.
const LOCAL_EXECUTORS = [
	{ value: "openai-compatible", label: "OpenAI-compatible (LM Studio / gateway)" },
	{ value: "ollama", label: "Ollama (local)" },
	{ value: "llama-cpp", label: "llama.cpp (local)" },
] as const;

// Classify a stored executor value into a backend kind.
function backendKind(exec: string): "none" | "provider" | "local" | "acpx" {
	if (!exec) return "none";
	if (exec === "acpx") return "acpx";
	if (LOCAL_EXECUTORS.some((e) => e.value === exec)) return "local";
	return "provider"; // any catalog provider family
}

// Catalog family whose models apply to a given executor. Provider backends use
// the family itself; openai-compatible local servers map to the OpenAI catalog
// (LM Studio etc. expose OpenAI-shaped ids). ollama/llama-cpp have no catalog.
function backendFamily(exec: string): string {
	if (backendKind(exec) === "local") return exec === "openai-compatible" ? "openai" : "";
	return exec;
}

function modelOptionsFor(exec: string): Array<{ value: string; label: string }> {
	if (!catalog) return [];
	const family = backendFamily(exec);
	if (!family) return [];
	return (catalog.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));
}

// Build the backend dropdown. Connected providers come first (you can only run
// a backend you've connected), then local servers, then ACPX. The current
// value is always included so a disconnected provider's trigger still renders.
function backendOptions(current: string, includeAcpx: boolean): Array<{ value: string; label: string }> {
	const opts: Array<{ value: string; label: string }> = [{ value: "", label: "— none —" }];
	for (const p of connectableProviders().filter((p) => p.connected)) opts.push({ value: p.id, label: p.name });
	for (const e of LOCAL_EXECUTORS) opts.push({ value: e.value, label: e.label });
	if (includeAcpx) opts.push({ value: "acpx", label: "ACPX (harness subprocess)" });
	if (current && !opts.some((o) => o.value === current)) {
		opts.push({ value: current, label: `${PROVIDER_NAMES[current] ?? titleCase(current)} (disconnected)` });
	}
	return opts;
}

// Conventional secret name for an executor's provider family (placeholder hint
// only — the connect wall owns real credential storage).
function secretNameFor(exec: string): string {
	const family = backendFamily(exec) || "KEY";
	return `${family.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

function ensureAccount(accountName: string, family: string): void {
	st.aSetStr(["inference", "accounts", accountName, "kind"], "api");
	st.aSetStr(["inference", "accounts", accountName, "providerFamily"], family);
}

function writeTarget(opts: {
	targetName: string;
	accountName: string; // per-target account used for local openai-compatible keys
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
	// A target write must leave routing routable: targets/accounts/workloads
	// without a policy dead-end every generation path in "No routing policy is
	// configured." (#1072). Emit an explicit default policy bound to this target
	// when none exists; leave user-authored policies alone.
	const existingPolicies = st.get(st.agent, "inference", "policies");
	if (
		existingPolicies == null ||
		typeof existingPolicies !== "object" ||
		Array.isArray(existingPolicies) ||
		Object.keys(existingPolicies).length === 0
	) {
		st.set(st.agent, ["inference", "policies", "default"], {
			mode: "automatic",
			defaultTargets: [`${targetName}/default`],
			fallbackTargets: [`${targetName}/default`],
		});
		if (!st.aStr(["inference", "defaultPolicy"])) {
			st.aSetStr(["inference", "defaultPolicy"], "default");
		}
	}
	// A model is only valid for its own provider family, so a backend switch
	// must clear the stale model (and its legacy label) to force a re-pick —
	// otherwise switching ollama:gemma3 -> anthropic would leave the routing
	// target and the extraction_model DB label on a model the new backend never
	// serves (#1017).
	const priorExecutor = st.aStr([...targetBase, "executor"]);
	if (priorExecutor && priorExecutor !== executor) {
		st.aDel([...targetBase, "models"]);
	}
	st.aSetStr([...targetBase, "executor"], executor);
	st.aSetStr([...workloadBase, "target"], `${targetName}/default`);
	const kind = backendKind(executor);
	// Clear fields that don't apply so stale config from a prior selection can't
	// leak (endpoint on a provider backend, account on acpx, acpx on a provider…).
	if (kind !== "acpx") st.aDel([...targetBase, "acpx"]);
	if (kind !== "local") st.aDel([...targetBase, "endpoint"]);
	if (kind === "provider") {
		// Reference a connected account for this family (resolved by family, not
		// literal name, since accounts may be named e.g. `openrouter-api`).
		// Credentials live in the connect wall — no inline key here.
		const acct = accountForFamily(executor) ?? executor;
		st.aSetStr([...targetBase, "account"], acct);
		st.aDel(accountBase); // never use the per-target account for a provider backend
		return;
	}
	if (kind === "acpx") {
		st.aDel([...targetBase, "account"]);
		st.aDel(accountBase);
		return;
	}
	// local: ollama/llama-cpp are keyless; openai-compatible links a per-target
	// account only when a key is present (optional key).
	const hasKey = !!st.aStr([...accountBase, "credentialRef"]);
	const needsAccount = executor === "openai-compatible" && hasKey;
	if (!needsAccount) {
		st.aDel([...targetBase, "account"]);
		st.aDel(accountBase);
	} else {
		st.aSetStr([...targetBase, "account"], accountName);
		ensureAccount(accountName, "openai");
	}
}

function bgModelId(): string {
	return st.aStr(["inference", "targets", TARGET_NAME, "models", "default", "model"]);
}
function bgSetModelId(v: string): void {
	st.aSetStr(["inference", "targets", TARGET_NAME, "models", "default", "model"], v);
	syncExtractionLabel();
}

// Keep the legacy extraction label (memory.pipelineV2.extraction{Provider,Model})
// in sync with the background routing target so pipeline logs, telemetry, and
// the extraction_model DB column report the model actually in use instead of
// the qwen3:4b default (#1017). Routing stays authoritative post-#947; this
// label is purely informational. Mirrors applyAcpxDashboardSetup for the non-ACPX
// path. InferenceSection is the sole live writer of this label; PipelineSection's
// extraction provider/model setters are retained but currently unbound.
function syncExtractionLabel(): void {
	const { provider, model } = extractionLabelForRoutingTarget(bgExecutor(), bgModelId());
	const base = ["memory", "pipelineV2"];
	if (provider) st.aSetStr([...base, "extractionProvider"], provider);
	else st.aDel([...base, "extractionProvider"]);
	if (model) st.aSetStr([...base, "extractionModel"], model);
	else st.aDel([...base, "extractionModel"]);
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
	const prior = bgAcpxAgent();
	st.aSetStr(["inference", "targets", TARGET_NAME, "acpx", "agent"], v);
	// An ACPX agent switch changes which models can run (claude:haiku vs codex:gpt),
	// so clear the stale model and re-sync the label exactly like a backend switch.
	if (prior && prior !== v) {
		st.aDel(["inference", "targets", TARGET_NAME, "models"]);
		syncExtractionLabel();
	}
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
	return modelOptionsFor(bgExecutor());
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
	return modelOptionsFor(aggExecutor());
}
const aggIsLocal = $derived(backendKind(aggExecutor()) === "local");
// The inline API-key field only applies to local openai-compatible servers
// (provider backends get their key from the connect wall).
const aggNeedsApiKey = $derived(aggExecutor() === "openai-compatible");

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

const isLocalExecutor = $derived(backendKind(bgExecutor()) === "local");
const needsApiKey = $derived(bgExecutor() === "openai-compatible");
const embNonNative = $derived(embProvider() && embProvider() !== "native" && embProvider() !== "");
</script>

<FormSection>

	<!-- ============================================================ -->
	<!-- Providers (connected only + Add picker)                       -->
	<!-- ============================================================ -->
	<SettingList title="Providers">
		<div class="provider-list">
			{#each connectedList() as provider (provider.id)}
				<button
					class="provider-row provider-row--connected"
					onclick={() => openConnect(provider)}
				>
					<span class="provider-row-name">{provider.name}</span>
					<span class="provider-row-meta">
						{#if provider.supportsOAuth && provider.supportsApiKey}Sign in or key{:else if provider.supportsOAuth}Sign in{:else}API key{/if}
						{#if catalog?.models[provider.id]?.length}· {catalog.models[provider.id].length} models{/if}
					</span>
					<span class="status-badge status-badge--ok"><CheckCircle class="size-3" /> Connected</span>
				</button>
			{:else}
				{#if catalogFailed}
					<div class="provider-empty">Couldn't load the provider catalog. Update the daemon and retry.</div>
				{:else if !catalog}
					<div class="provider-empty">Loading providers…</div>
				{:else}
					<div class="provider-empty">No providers connected yet.</div>
				{/if}
			{/each}
		</div>
		<button class="add-provider-btn" onclick={() => (showPicker = true)}>
			<Plus class="size-3.5" /> Add provider
		</button>
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
	<!-- Background + Aggregation (two-column)                         -->
	<!-- ============================================================ -->
	<div class="workload-grid">
	<SettingList title="Background inference">
		<SettingRow compact
			title="Backend"
			description="Which backend runs memory extraction and synthesis. Direct API providers (Anthropic/OpenRouter) are powered by pi-ai; local servers (LM Studio/Ollama/llama.cpp) connect via an OpenAI-compatible endpoint; ACPX drives a harness subprocess (Claude/Codex/OpenCode)."
		>
			<Select.Root type="single" value={bgExecutor()} onValueChange={(v) => bgSetExecutor(v)}>
				<Select.Trigger class={selectTriggerClass}>
					{backendOptions(bgExecutor(), true).find((o) => o.value === bgExecutor())?.label ?? "— none —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each backendOptions(bgExecutor(), true) as opt (opt.value)}
						<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingRow>

		{#if bgExecutor() && bgExecutor() !== ""}
			{#if bgExecutor() === "acpx"}
				<SettingRow compact title="ACPX agent" description="The harness ACPX drives.">
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
				<SettingRow compact
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
				<SettingRow compact
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
				<SettingRow compact
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
		<SettingRow compact
			title="Backend"
			description="Which backend runs aggregate recall (query-time evidence synthesis). Latency-sensitive and pi-ai-only — ACPX subprocesses are excluded because spawn latency would dominate."
		>
			<Select.Root type="single" value={aggExecutor()} onValueChange={(v) => aggSetExecutor(v)}>
				<Select.Trigger class={selectTriggerClass}>
					{backendOptions(aggExecutor(), false).find((o) => o.value === aggExecutor())?.label ?? "— none —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each backendOptions(aggExecutor(), false) as opt (opt.value)}
						<Select.Item class={selectItemClass} value={opt.value} label={opt.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingRow>

		{#if aggExecutor() && aggExecutor() !== ""}
			<SettingRow compact
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
				<SettingRow compact
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
				<SettingRow compact
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
	</div><!-- /workload-grid -->

	<!-- ============================================================ -->
	<!-- Embeddings                                                   -->
	<!-- ============================================================ -->
	<SettingList title="Embeddings">
		<SettingRow compact
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
			<SettingRow compact title="Model" description="The model id your embedding provider exposes.">
				<Input
					class={inputClass}
					value={embModel()}
					placeholder="nomic-embed-text"
					oninput={(e) => embSetModel(e.currentTarget.value)}
				/>
			</SettingRow>
			<SettingRow compact title="Endpoint" description="Base URL of the embedding server.">
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

{#if showPicker}
	<div
		class="dialog-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) showPicker = false;
		}}
	>
		<div class="picker-panel" role="dialog" aria-modal="true" aria-label="Add a provider">
			<header class="picker-head">
				<h2 class="picker-title">Add a provider</h2>
				<button bind:this={pickerCloseBtn} class="picker-close" onclick={() => (showPicker = false)} aria-label="Close">✕</button>
			</header>
			<div class="picker-list">
				{#each availableList() as provider (provider.id)}
					<button class="picker-row" onclick={() => openConnect(provider)}>
						<span class="picker-row-name">{provider.name}</span>
						<span class="picker-row-meta">
							{#if provider.supportsOAuth && provider.supportsApiKey}Sign in or key{:else if provider.supportsOAuth}Sign in{:else}API key{/if}
							{#if catalog?.models[provider.id]?.length}· {catalog.models[provider.id].length} models{/if}
						</span>
						<Plus class="size-3" />
					</button>
				{:else}
					<div class="provider-empty">No more providers available.</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

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
	.provider-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}
	.provider-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 9px;
		border: 1px solid var(--sig-border);
		border-radius: 7px;
		background: var(--sig-bg);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.12s, background 0.12s;
	}
	.provider-row:hover {
		border-color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}
	.provider-row--connected {
		border-color: rgba(74, 222, 128, 0.35);
	}
	.provider-row-name {
		flex: 0 0 auto;
		font-family: var(--font-body);
		font-size: 11.5px;
		font-weight: 600;
		color: var(--sig-text);
		white-space: nowrap;
	}
	.provider-row-meta {
		flex: 1 1 auto;
		font-family: var(--font-body);
		font-size: 10px;
		color: var(--sig-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.status-badge {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-body);
		font-size: 9px;
		font-weight: 500;
		padding: 2px 6px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.status-badge--ok {
		color: #4ade80;
		background: rgba(74, 222, 128, 0.12);
	}
	.provider-empty {
		font-family: var(--font-body);
		font-size: 11px;
		color: var(--sig-text-muted);
		padding: 8px;
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

	/* Two-column workload grid: background + aggregation side by side.
	   Stacks on narrow viewports. Embeddings stays full-width below. */
	.workload-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-lg);
		align-items: start;
	}
	@media (max-width: 900px) {
		.workload-grid {
			grid-template-columns: 1fr;
		}
	}

	.add-provider-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-top: 6px;
		padding: 5px 10px;
		border: 1px dashed var(--sig-border-strong);
		border-radius: 7px;
		background: transparent;
		color: var(--sig-text-muted);
		font-family: var(--font-body);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: border-color 0.12s, color 0.12s;
	}
	.add-provider-btn:hover {
		border-color: var(--sig-accent);
		color: var(--sig-text);
	}

	/* Add-provider picker modal */
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}
	.picker-panel {
		background: var(--sig-surface);
		border: 1px solid var(--sig-border-strong);
		border-radius: 12px;
		width: 100%;
		max-width: 480px;
		max-height: 70vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.picker-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--sig-border);
	}
	.picker-title {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
		color: var(--sig-text);
		margin: 0;
	}
	.picker-close {
		background: none;
		border: none;
		color: var(--sig-text-muted);
		cursor: pointer;
		font-size: 14px;
		padding: 4px;
		border-radius: 4px;
	}
	.picker-close:hover {
		color: var(--sig-text);
		background: var(--sig-surface-raised);
	}
	.picker-list {
		overflow-y: auto;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.picker-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 9px;
		border: 1px solid var(--sig-border);
		border-radius: 7px;
		background: var(--sig-bg);
		cursor: pointer;
		text-align: left;
		color: var(--sig-text);
	}
	.picker-row:hover {
		border-color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}
	.picker-row-name {
		font-family: var(--font-body);
		font-size: 11.5px;
		font-weight: 600;
		white-space: nowrap;
	}
	.picker-row-meta {
		flex: 1 1 auto;
		font-family: var(--font-body);
		font-size: 10px;
		color: var(--sig-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
