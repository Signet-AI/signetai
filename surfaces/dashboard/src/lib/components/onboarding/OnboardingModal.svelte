<script lang="ts">
import { invalidateAll } from "$app/navigation";
import { type ConfigFile, type DaemonStatus, type Harness, type MemoryStats, saveConfigFileResult } from "$lib/api";
import { applyRecommendedPipelineSetup } from "$lib/components/tabs/settings/pipeline-settings";
import { Button } from "$lib/components/ui/button/index.js";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import type { TabId } from "$lib/stores/navigation.svelte";
import { KNOWN_HARNESSES, st } from "$lib/stores/settings.svelte";
import { toast } from "$lib/stores/toast.svelte";
import { type PipelineProviderChoice, defaultPipelineModel } from "@signet/core/pipeline-providers";
import { onMount, untrack } from "svelte";
import { stringify } from "yaml";

interface Props {
	configFiles: ConfigFile[];
	memoryStats: MemoryStats;
	daemonStatus: DaemonStatus | null;
	harnesses?: Harness[];
	onnavigate?: (tab: TabId) => void;
}

type ProviderOption = {
	value: PipelineProviderChoice;
	label: string;
	detail: string;
	mode: "agent" | "local" | "api" | "off" | "custom";
	endpointPlaceholder?: string;
};

const { configFiles, memoryStats, daemonStatus, harnesses = [], onnavigate }: Props = $props();

const PROVIDERS: ProviderOption[] = [
	{
		value: "acpx",
		label: "ACPX",
		detail: "Route extraction through a selected installed agent harness.",
		mode: "agent",
	},
	{
		value: "llama-cpp",
		label: "llama.cpp",
		detail: "Use a local llama.cpp OpenAI-compatible server.",
		mode: "local",
		endpointPlaceholder: "http://127.0.0.1:8080/v1",
	},
	{
		value: "ollama",
		label: "Ollama",
		detail: "Use an Ollama daemon running on this machine or LAN.",
		mode: "local",
		endpointPlaceholder: "http://127.0.0.1:11434",
	},
	{
		value: "claude-code",
		label: "Claude Code",
		detail: "Call the local Claude Code CLI directly for extraction.",
		mode: "agent",
	},
	{
		value: "codex",
		label: "Codex",
		detail: "Call the local Codex CLI directly for extraction.",
		mode: "agent",
	},
	{
		value: "opencode",
		label: "OpenCode",
		detail: "Use OpenCode as the extraction backend.",
		mode: "agent",
	},
	{
		value: "anthropic",
		label: "Anthropic API",
		detail: "Use Anthropic directly with configured secrets.",
		mode: "api",
		endpointPlaceholder: "https://api.anthropic.com",
	},
	{
		value: "openrouter",
		label: "OpenRouter",
		detail: "Use OpenRouter with configured secrets.",
		mode: "api",
		endpointPlaceholder: "https://openrouter.ai/api/v1",
	},
	{
		value: "command",
		label: "Command",
		detail: "Use a custom command provider configured in advanced settings.",
		mode: "custom",
	},
	{
		value: "none",
		label: "Off",
		detail: "Leave extraction disabled for now; configure it later.",
		mode: "off",
	},
];

const MODEL_PRESETS: Partial<Record<PipelineProviderChoice, string[]>> = {
	acpx: ["gpt-5-codex-mini", "gpt-5-codex", "claude-haiku-4-5"],
	"llama-cpp": ["qwen3.5:4b", "qwen3:8b", "llama-3.1-8b"],
	ollama: ["qwen3:4b", "qwen3:8b", "glm-4.7-flash"],
	"claude-code": ["haiku", "sonnet", "opus"],
	codex: ["gpt-5-codex-mini", "gpt-5-codex", "gpt-5.4"],
	opencode: ["anthropic/claude-haiku-4-5-20251001", "google/gemini-2.5-flash"],
	anthropic: ["haiku", "sonnet", "opus"],
	openrouter: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5-20251001"],
};

let open = $state(false);
let initialized = $state(false);
let saving = $state(false);
let agentName = $state("My Agent");
let agentDescription = $state("Personal AI assistant");
let provider = $state<PipelineProviderChoice>("acpx");
let model = $state("gpt-5-codex-mini");
let endpoint = $state("");
let selectedHarness = $state("");
let selectedHarnesses = $state<string[]>([]);
let synthesisEnabled = $state(true);
// biome-ignore lint/style/useConst: Svelte state is mutated by onboarding buttons.
let afterSaveTab = $state<TabId | "stay" | "sources">("sources");
let forceOpen = false;

const storageKey = $derived(`signet:onboarding:dismissed:${daemonStatus?.agentsDir ?? "unknown"}`);
const providerOption = $derived(PROVIDERS.find((option) => option.value === provider) ?? PROVIDERS[0]);
const harnessOptions = $derived.by(() => {
	const fromApi = harnesses.map((h) => h.id || h.name).filter(Boolean);
	const combined = [...new Set([...fromApi, ...KNOWN_HARNESSES])];
	return combined.map((id) => ({
		id,
		meta: harnesses.find((h) => h.id === id || h.name === id),
	}));
});
const selectedProviderModels = $derived(MODEL_PRESETS[provider] ?? []);
const needsEndpoint = $derived(providerOption.mode === "local" || providerOption.mode === "api");

function readPipelineString(...path: string[]): string {
	return st.aStr(["memory", "pipelineV2", ...path]);
}

function currentProvider(): PipelineProviderChoice {
	const raw = readPipelineString("extractionProvider") || readPipelineString("extraction", "provider");
	return PROVIDERS.some((option) => option.value === raw) ? (raw as PipelineProviderChoice) : "acpx";
}

function hydrateFromSettings(): void {
	st.init(configFiles);
	agentName = st.aStr(["agent", "name"]) || st.aStr(["name"]) || "My Agent";
	agentDescription = st.aStr(["agent", "description"]) || st.aStr(["description"]) || "Personal AI assistant";
	provider = currentProvider();
	model =
		readPipelineString("extractionModel") ||
		readPipelineString("extraction", "model") ||
		defaultPipelineModel(provider);
	endpoint =
		readPipelineString("extraction", "endpoint") ||
		readPipelineString("extractionEndpoint") ||
		readPipelineString("extractionBaseUrl") ||
		"";
	selectedHarness = readPipelineString("extraction", "harness") || "";
	selectedHarnesses = st.harnessArray();
	if (selectedHarnesses.length === 0 && harnessOptions.length > 0) selectedHarnesses = [harnessOptions[0].id];
	if (!selectedHarness && selectedHarnesses.length > 0) selectedHarness = selectedHarnesses[0];
	synthesisEnabled = provider !== "none";
	initialized = true;
}

function isDefaultishWorkspace(): boolean {
	const name = agentName.trim().toLowerCase();
	return memoryStats.total === 0 && (name === "my agent" || name.length === 0);
}

function maybeOpen(): void {
	if (typeof window === "undefined") return;
	if (!initialized || !daemonStatus) return;
	if (forceOpen) {
		open = true;
		return;
	}
	if (localStorage.getItem(storageKey) === "true") return;
	if (isDefaultishWorkspace()) open = true;
}

onMount(() => {
	forceOpen = new URLSearchParams(window.location.search).get("onboarding") === "1";
	untrack(hydrateFromSettings);
	maybeOpen();
});

$effect(() => {
	const _configFiles = configFiles;
	const _harnesses = harnesses;
	void _configFiles;
	void _harnesses;
	untrack(hydrateFromSettings);
});

$effect(() => {
	const _daemonStatus = daemonStatus;
	const _memoryTotal = memoryStats.total;
	void _daemonStatus;
	void _memoryTotal;
	maybeOpen();
});

function chooseProvider(next: PipelineProviderChoice): void {
	provider = next;
	model = MODEL_PRESETS[next]?.[0] ?? defaultPipelineModel(next);
	endpoint = PROVIDERS.find((option) => option.value === next)?.endpointPlaceholder ?? "";
	if (next === "none") endpoint = "";
}

function toggleHarness(id: string, checked: boolean | string): void {
	if (checked) {
		selectedHarnesses = [...new Set([...selectedHarnesses, id])];
		if (!selectedHarness) selectedHarness = id;
		return;
	}
	selectedHarnesses = selectedHarnesses.filter((h) => h !== id);
	if (selectedHarness === id) selectedHarness = selectedHarnesses[0] ?? "";
}

function dismiss(): void {
	forceOpen = false;
	localStorage.setItem(storageKey, "true");
	open = false;
}

function openSettings(): void {
	dismiss();
	onnavigate?.("settings");
}

async function persistOnboardingConfig(): Promise<void> {
	if (st.agentFile) {
		await st.save();
		return;
	}
	const result = await saveConfigFileResult("agent.yaml", stringify(st.agent));
	if (!result.ok) throw new Error(result.error ?? `Failed to create agent.yaml (${result.status})`);
	st.agentSnapshot = JSON.stringify(st.agent);
}

async function finish(): Promise<void> {
	if (saving) return;
	saving = true;
	try {
		st.aSetStr(["agent", "name"], agentName.trim() || "My Agent");
		st.aSetStr(["agent", "description"], agentDescription.trim() || "Personal AI assistant");
		st.set(st.agent, ["harnesses"], selectedHarnesses);
		applyRecommendedPipelineSetup(st.agent, {
			provider,
			model,
			endpoint: needsEndpoint ? endpoint : "",
			acpxHarness: provider === "acpx" ? selectedHarness : "",
			synthesisEnabled,
		});
		st.agent = { ...st.agent };
		await persistOnboardingConfig();
		forceOpen = false;
		localStorage.setItem(storageKey, "true");
		open = false;
		await invalidateAll();
		toast("Onboarding saved", "success");
		if (afterSaveTab === "sources") onnavigate?.("sources");
		else if (afterSaveTab !== "stay") onnavigate?.(afterSaveTab);
	} finally {
		saving = false;
	}
}
</script>

{#if open}
	<div class="onboarding-backdrop" role="presentation">
		<div class="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabindex="-1">
			<header class="onboarding-header">
				<div>
					<p class="eyebrow">Dashboard onboarding</p>
					<h2 id="onboarding-title">Bring this agent online</h2>
					<p class="lede">Name the agent, choose the harnesses it should sync into, and wire the memory pipeline to something real.</p>
				</div>
				<button class="icon-button" type="button" aria-label="Dismiss onboarding" onclick={dismiss}>×</button>
			</header>

			<div class="onboarding-body">
				<section class="setup-panel identity-panel">
					<div class="section-head">
						<span class="step">01</span>
						<div>
							<h3>Identity</h3>
							<p>What should harnesses call this agent?</p>
						</div>
					</div>
					<div class="field-grid">
						<label class="field">
							<span>Name</span>
							<Input bind:value={agentName} placeholder="Dot" />
						</label>
						<label class="field field-wide">
							<span>Description</span>
							<Textarea rows={3} bind:value={agentDescription} placeholder="A portable memory agent for..." />
						</label>
					</div>
				</section>

				<section class="setup-panel">
					<div class="section-head">
						<span class="step">02</span>
						<div>
							<h3>Harnesses</h3>
							<p>Loaded from the daemon. Pick every surface Signet should keep configured.</p>
						</div>
					</div>
					<div class="harness-list">
						{#each harnessOptions as h (h.id)}
							<label class="harness-row" class:harness-row-active={selectedHarnesses.includes(h.id)}>
								<Checkbox checked={selectedHarnesses.includes(h.id)} onCheckedChange={(checked) => toggleHarness(h.id, checked)} />
								<span class="status-dot" class:status-dot-installed={h.meta?.exists}></span>
								<span class="harness-main">
									<strong>{h.id}</strong>
									<small>{h.meta?.path ?? "known harness"}</small>
								</span>
								<span class="harness-state">{h.meta?.exists ? "installed" : "not found"}</span>
							</label>
						{/each}
					</div>
				</section>

				<section class="setup-panel setup-panel-wide">
					<div class="section-head">
						<span class="step">03</span>
						<div>
							<h3>Memory engine</h3>
							<p>Choose the extraction provider. Provider-specific fields appear below.</p>
						</div>
					</div>

					<div class="provider-grid">
						{#each PROVIDERS as option (option.value)}
							<button type="button" class="provider-card" class:provider-card-active={provider === option.value} onclick={() => chooseProvider(option.value)}>
								<span>{option.label}</span>
								<small>{option.detail}</small>
							</button>
						{/each}
					</div>

					<div class="provider-detail">
						<div class="detail-banner">
							<span>{providerOption.mode}</span>
							<p>{providerOption.detail}</p>
						</div>

						{#if provider === "acpx"}
							<div class="field field-wide">
								<span>ACPX harness</span>
								<div class="choice-row">
									{#each selectedHarnesses as h (h)}
										<button type="button" class="choice-pill" class:choice-pill-active={selectedHarness === h} onclick={() => { selectedHarness = h; }}>{h}</button>
									{/each}
									{#if selectedHarnesses.length === 0}<small>Select at least one harness above.</small>{/if}
								</div>
							</div>
						{/if}

						<div class="field-grid">
							<label class="field">
								<span>Model</span>
								<Input bind:value={model} placeholder="model id" disabled={provider === "none"} />
							</label>
							{#if needsEndpoint}
								<label class="field">
									<span>Endpoint URL</span>
									<Input bind:value={endpoint} placeholder={providerOption.endpointPlaceholder ?? "https://..."} />
								</label>
							{/if}
						</div>

						{#if selectedProviderModels.length > 0 && provider !== "none"}
							<div class="choice-row">
								{#each selectedProviderModels as preset (preset)}
									<button type="button" class="choice-pill" class:choice-pill-active={model === preset} onclick={() => { model = preset; }}>{preset}</button>
								{/each}
							</div>
						{/if}

						<label class="inline-toggle">
							<Checkbox checked={synthesisEnabled} onCheckedChange={(checked) => { synthesisEnabled = !!checked; }} />
							<span>Use the same provider for session synthesis</span>
						</label>
					</div>
				</section>

				<section class="setup-panel setup-panel-wide next-panel">
					<div class="section-head">
						<span class="step">04</span>
						<div>
							<h3>Next step</h3>
							<p>After saving, continue to the surface that actually brings context in.</p>
						</div>
					</div>
					<div class="choice-row">
						<button type="button" class="choice-pill" class:choice-pill-active={afterSaveTab === "sources"} onclick={() => { afterSaveTab = "sources"; }}>Connect sources</button>
						<button type="button" class="choice-pill" class:choice-pill-active={afterSaveTab === "settings"} onclick={() => { afterSaveTab = "settings"; }}>Review settings</button>
						<button type="button" class="choice-pill" class:choice-pill-active={afterSaveTab === "stay"} onclick={() => { afterSaveTab = "stay"; }}>Stay here</button>
					</div>
				</section>
			</div>

			<footer class="onboarding-actions">
				<Button variant="ghost" type="button" onclick={openSettings}>Open full settings</Button>
				<div class="action-cluster">
					<Button variant="outline" type="button" onclick={dismiss}>Skip</Button>
					<Button type="button" onclick={finish} disabled={saving}>{saving ? "Saving…" : "Save onboarding"}</Button>
				</div>
			</footer>
		</div>
	</div>
{/if}

<style>
	.onboarding-backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		display: grid;
		place-items: center;
		padding: 22px;
		background: color-mix(in srgb, var(--sig-bg), transparent 18%);
		backdrop-filter: blur(2px);
	}

	.onboarding-modal {
		width: min(1040px, 100%);
		max-height: min(880px, calc(100vh - 44px));
		display: flex;
		flex-direction: column;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		box-shadow: 0 0 0 1px var(--sig-bg), 0 20px 70px rgba(0, 0, 0, 0.55);
		overflow: hidden;
	}

	.onboarding-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
		padding: 20px 22px 18px;
		border-bottom: 1px solid var(--sig-border-strong);
		background: linear-gradient(90deg, color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 4%), var(--sig-bg));
	}

	.eyebrow,
	.field > span,
	.step,
	.harness-state {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.13em;
		text-transform: uppercase;
		color: var(--sig-highlight);
	}

	.eyebrow,
	h2,
	.lede,
	h3,
	.section-head p {
		margin: 0;
	}

	h2 {
		margin-top: 4px;
		font-family: var(--font-display, var(--font-heading, inherit));
		font-size: clamp(28px, 4vw, 44px);
		line-height: 0.95;
		letter-spacing: -0.04em;
		color: var(--sig-text-bright);
		text-transform: uppercase;
	}

	.lede {
		max-width: 680px;
		margin-top: 10px;
		font-size: 14px;
		line-height: 1.5;
		color: var(--sig-text);
	}

	.icon-button {
		width: 38px;
		height: 38px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-surface-raised);
		color: var(--sig-text);
		font-size: 22px;
		cursor: pointer;
	}

	.onboarding-body {
		display: grid;
		grid-template-columns: minmax(260px, 0.9fr) minmax(380px, 1.4fr);
		gap: 12px;
		padding: 14px;
		overflow: auto;
	}

	.setup-panel {
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
		padding: 14px;
	}

	.setup-panel-wide {
		grid-column: 2;
	}

	.identity-panel {
		grid-row: span 1;
	}

	.section-head {
		display: flex;
		gap: 11px;
		align-items: flex-start;
		margin-bottom: 12px;
	}

	.step {
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		color: var(--sig-text-bright);
	}

	h3 {
		font-family: var(--font-display, inherit);
		font-size: 18px;
		letter-spacing: 0.02em;
		color: var(--sig-text-bright);
		text-transform: uppercase;
	}

	.section-head p,
	.provider-card small,
	.harness-main small,
	.detail-banner p {
		font-size: 12px;
		line-height: 1.4;
		color: var(--sig-text-muted);
	}

	.field-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.field,
	.harness-main {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	.harness-list,
	.provider-detail {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.harness-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		cursor: pointer;
	}

	.harness-row-active {
		border-color: var(--sig-border-strong);
		background: color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 5%);
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border: 1px solid var(--sig-text-muted);
		background: transparent;
	}

	.status-dot-installed {
		border-color: var(--sig-success);
		background: var(--sig-success);
	}

	.harness-main {
		min-width: 0;
		flex: 1;
	}

	.harness-main strong {
		font-size: 13px;
		color: var(--sig-text-bright);
	}

	.harness-main small {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.provider-grid {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 8px;
		margin-bottom: 12px;
	}

	.provider-card {
		min-height: 92px;
		padding: 10px;
		text-align: left;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		color: var(--sig-text);
		cursor: pointer;
	}

	.provider-card span {
		display: block;
		margin-bottom: 7px;
		font-family: var(--font-display, inherit);
		font-size: 13px;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.provider-card-active {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-bg), var(--sig-highlight) 9%);
		box-shadow: inset 3px 0 0 var(--sig-highlight);
	}

	.detail-banner {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 10px 12px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-surface-raised);
	}

	.detail-banner span {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		text-transform: uppercase;
		color: var(--sig-highlight);
	}

	.choice-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.choice-pill {
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		color: var(--sig-text);
		padding: 7px 10px;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		cursor: pointer;
	}

	.choice-pill-active {
		border-color: var(--sig-highlight);
		color: var(--sig-text-bright);
		background: color-mix(in srgb, var(--sig-bg), var(--sig-highlight) 8%);
	}

	.inline-toggle {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 12px;
		color: var(--sig-text);
	}

	.next-panel {
		background: color-mix(in srgb, var(--sig-surface), var(--sig-highlight) 3%);
	}

	.onboarding-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px;
		border-top: 1px solid var(--sig-border-strong);
		background: var(--sig-surface);
	}

	.action-cluster {
		display: flex;
		gap: 10px;
	}

	@media (max-width: 900px) {
		.onboarding-body,
		.field-grid,
		.provider-grid {
			grid-template-columns: 1fr;
		}

		.setup-panel-wide {
			grid-column: auto;
		}
	}
</style>
