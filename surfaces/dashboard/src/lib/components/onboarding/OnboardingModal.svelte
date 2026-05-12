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
		<div class="onboarding-modal sig-panel" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabindex="-1">
			<header class="onboarding-header sig-panel-header">
				<div class="header-copy">
					<div class="header-kicker">
						<span class="signal-dot"></span>
						<span>FIRST_RUN_SEQUENCE</span>
						<span class="header-coordinate">AGENT_BOOTSTRAP / 04</span>
					</div>
					<h2 id="onboarding-title">Bring this agent online</h2>
					<p class="lede">Set identity, harness sync, and memory extraction. Everything can change later.</p>
				</div>
				<button class="icon-button sig-switch" type="button" aria-label="Dismiss onboarding" onclick={dismiss}>×</button>
			</header>

			<div class="progress-rail" aria-hidden="true">
				<span class="progress-node progress-node-active">01 Identity</span>
				<span class="progress-line"></span>
				<span class="progress-node progress-node-active">02 Harness</span>
				<span class="progress-line"></span>
				<span class="progress-node progress-node-active">03 Memory</span>
				<span class="progress-line progress-line-muted"></span>
				<span class="progress-node">04 Sources</span>
			</div>

			<div class="onboarding-body">
				<aside class="setup-summary setup-panel" aria-hidden="true">
					<div class="summary-readout">
						<span class="summary-label">ACTIVE PROFILE</span>
						<strong>{agentName.trim() || "My Agent"}</strong>
						<p>{agentDescription.trim() || "Personal AI assistant"}</p>
					</div>
					<div class="summary-grid">
						<div>
							<span>provider</span>
							<strong>{providerOption.label}</strong>
						</div>
						<div>
							<span>model</span>
							<strong>{provider === "none" ? "disabled" : model}</strong>
						</div>
						<div>
							<span>harnesses</span>
							<strong>{selectedHarnesses.length || 0} selected</strong>
						</div>
						<div>
							<span>next</span>
							<strong>{afterSaveTab === "sources" ? "sources" : afterSaveTab === "settings" ? "settings" : "dashboard"}</strong>
						</div>
					</div>
					<p class="summary-note">Recommended: keep the default harness, choose the extraction backend you already trust, then connect sources.</p>
				</aside>

				<main class="setup-main">
					<section class="setup-panel identity-panel">
						<div class="section-head">
							<span class="step">01</span>
							<div>
								<h3>Identity</h3>
								<p>Give the agent a recognizable name before syncing it into tools.</p>
							</div>
						</div>
						<div class="field-grid">
							<label class="field">
								<span>Name</span>
								<Input class="onboarding-input" bind:value={agentName} placeholder="Dot" />
							</label>
							<label class="field field-wide">
								<span>Description</span>
								<Textarea class="onboarding-input onboarding-textarea" rows={2} bind:value={agentDescription} placeholder="A portable memory agent for..." />
							</label>
						</div>
					</section>

					<section class="setup-panel">
						<div class="section-head">
							<span class="step">02</span>
							<div>
								<h3>Harness sync</h3>
								<p>Choose where Signet should maintain this identity. Installed harnesses are ready now.</p>
							</div>
						</div>
						<div class="harness-list">
							{#each harnessOptions as h (h.id)}
								<label class="harness-row sig-switch" class:harness-row-active={selectedHarnesses.includes(h.id)}>
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

					<section class="setup-panel memory-panel">
						<div class="section-head">
							<span class="step">03</span>
							<div>
								<h3>Memory engine</h3>
								<p>Pick the extraction path. The common choices are first; advanced routes stay available without dominating the flow.</p>
							</div>
						</div>

						<div class="provider-grid">
							<p class="provider-group-title">Recommended routes</p>
							{#each PROVIDERS as option (option.value)}
								{#if option.value === "acpx" || option.value === "ollama" || option.value === "codex" || option.value === "claude-code"}
									<button type="button" class="provider-card sig-switch" class:provider-card-active={provider === option.value} onclick={() => chooseProvider(option.value)}>
										<span class="provider-mode">{option.mode}</span>
										<strong>{option.label}</strong>
										<small>{option.detail}</small>
									</button>
								{/if}
							{/each}

							<p class="provider-group-title provider-group-title-secondary">Other routes</p>
							{#each PROVIDERS as option (option.value)}
								{#if option.value !== "acpx" && option.value !== "ollama" && option.value !== "codex" && option.value !== "claude-code"}
									<button type="button" class="provider-card provider-card-compact sig-switch" class:provider-card-active={provider === option.value} onclick={() => chooseProvider(option.value)}>
										<span class="provider-mode">{option.mode}</span>
										<strong>{option.label}</strong>
										<small>{option.detail}</small>
									</button>
								{/if}
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
											<button type="button" class="choice-pill sig-switch" class:choice-pill-active={selectedHarness === h} onclick={() => { selectedHarness = h; }}>{h}</button>
										{/each}
										{#if selectedHarnesses.length === 0}<small class="empty-hint">Select at least one harness above.</small>{/if}
									</div>
								</div>
							{/if}

							<div class="field-grid">
								<label class="field">
									<span>Model</span>
									<Input class="onboarding-input" bind:value={model} placeholder="model id" disabled={provider === "none"} />
								</label>
								{#if needsEndpoint}
									<label class="field">
										<span>Endpoint URL</span>
										<Input class="onboarding-input" bind:value={endpoint} placeholder={providerOption.endpointPlaceholder ?? "https://..."} />
									</label>
								{/if}
							</div>

							{#if selectedProviderModels.length > 0 && provider !== "none"}
								<div class="choice-row preset-row" aria-label="Model presets">
									{#each selectedProviderModels as preset (preset)}
										<button type="button" class="choice-pill sig-switch" class:choice-pill-active={model === preset} onclick={() => { model = preset; }}>{preset}</button>
									{/each}
								</div>
							{/if}

							<label class="inline-toggle sig-switch">
								<Checkbox checked={synthesisEnabled} onCheckedChange={(checked) => { synthesisEnabled = !!checked; }} />
								<span>Use the same provider for session synthesis</span>
							</label>
						</div>
					</section>

					<section class="setup-panel next-panel">
						<div class="section-head">
							<span class="step">04</span>
							<div>
								<h3>Continue</h3>
								<p>Save the basics, then move into the thing that makes memory useful: source connection.</p>
							</div>
						</div>
						<div class="choice-row next-row">
							<button type="button" class="choice-pill sig-switch" class:choice-pill-active={afterSaveTab === "sources"} onclick={() => { afterSaveTab = "sources"; }}>Connect sources</button>
							<button type="button" class="choice-pill sig-switch" class:choice-pill-active={afterSaveTab === "settings"} onclick={() => { afterSaveTab = "settings"; }}>Review settings</button>
							<button type="button" class="choice-pill sig-switch" class:choice-pill-active={afterSaveTab === "stay"} onclick={() => { afterSaveTab = "stay"; }}>Stay here</button>
						</div>
					</section>
				</main>
			</div>

			<footer class="onboarding-actions sig-panel-footer">
				<Button variant="ghost" type="button" onclick={openSettings}>Open full settings</Button>
				<div class="action-cluster">
					<Button variant="outline" type="button" onclick={dismiss}>Skip</Button>
					<Button type="button" onclick={finish} disabled={saving}>{saving ? "Saving…" : "Save and continue"}</Button>
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
		padding: 24px;
		background:
			radial-gradient(circle at 52% 16%, color-mix(in srgb, var(--sig-highlight), transparent 84%), transparent 32%),
			color-mix(in srgb, var(--sig-bg), transparent 10%);
		backdrop-filter: blur(5px) saturate(0.95);
	}

	.onboarding-modal {
		position: relative;
		width: min(1060px, 100%);
		max-height: min(900px, calc(100vh - 48px));
		display: flex;
		flex-direction: column;
		background: var(--sig-bg);
		overflow: hidden;
	}

	.onboarding-modal::before,
	.onboarding-modal::after {
		content: "";
		position: absolute;
		z-index: 2;
		pointer-events: none;
		width: 24px;
		height: 24px;
		border-color: var(--sig-border-strong);
		border-style: solid;
		opacity: 0.45;
	}

	.onboarding-modal::before {
		top: 10px;
		left: 10px;
		border-width: 1px 0 0 1px;
	}

	.onboarding-modal::after {
		right: 10px;
		bottom: 10px;
		border-width: 0 1px 1px 0;
	}

	.onboarding-header {
		position: relative;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
		padding: 20px 30px 18px;
		background:
			linear-gradient(var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(135deg, color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 8%), var(--sig-bg) 64%);
		background-size: 28px 28px, 28px 28px, auto;
		overflow: hidden;
	}

	.onboarding-header::after {
		content: "SIGNET / MEMORY / IDENTITY";
		position: absolute;
		right: 72px;
		bottom: -15px;
		font-family: var(--font-display, monospace);
		font-size: clamp(24px, 5vw, 58px);
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
		opacity: 0.022;
		white-space: nowrap;
		pointer-events: none;
	}

	.header-copy {
		position: relative;
		z-index: 1;
		max-width: 760px;
	}

	.header-kicker,
	.field > span,
	.step,
	.harness-state,
	.provider-mode,
	.summary-label,
	.summary-grid span {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.header-kicker {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
		color: var(--sig-highlight-text);
	}

	.signal-dot {
		width: 7px;
		height: 7px;
		border: 1px solid var(--sig-success);
		background: var(--sig-success);
		box-shadow: 0 0 10px color-mix(in srgb, var(--sig-success), transparent 28%);
	}

	.header-coordinate {
		color: var(--sig-text-muted);
	}

	h2,
	.lede,
	h3,
	.section-head p,
	.summary-readout p {
		margin: 0;
	}

	h2 {
		font-family: var(--font-display, monospace);
		font-size: clamp(24px, 3.4vw, 38px);
		line-height: 0.94;
		letter-spacing: 0.06em;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		text-wrap: balance;
	}

	.lede {
		max-width: 650px;
		margin-top: 10px;
		font-size: 14px;
		line-height: 1.45;
		color: var(--sig-text);
	}

	.icon-button {
		position: relative;
		z-index: 3;
		width: 40px;
		height: 40px;
		color: var(--sig-text);
		font-size: 24px;
		line-height: 1;
		cursor: pointer;
	}

	.progress-rail {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 34px;
		border-right: 1px solid var(--sig-border);
		background: var(--sig-surface);
	}

	.progress-node {
		display: grid;
		place-items: center;
		width: auto;
		min-width: 82px;
		height: 22px;
		padding: 0 8px;
		border: 1px solid var(--sig-border);
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		color: var(--sig-text-muted);
		background: var(--sig-bg);
	}

	.progress-node-active {
		border-color: var(--sig-highlight-dim);
		color: var(--sig-highlight-text);
		background: var(--sig-highlight-muted);
	}

	.progress-line {
		flex: 1;
		height: 1px;
		background: linear-gradient(90deg, var(--sig-highlight), var(--sig-border-strong));
		opacity: 0.55;
	}

	.progress-line-muted {
		background: var(--sig-border);
	}

	.onboarding-body {
		display: grid;
		grid-template-columns: 1fr;
		gap: 18px;
		padding: 18px 18px 28px;
		overflow: auto;
		background:
			radial-gradient(circle at 22% 18%, var(--sig-highlight-dim), transparent 28%),
			var(--sig-bg);
	}

	.setup-main {
		display: grid;
		grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
		gap: 18px;
		align-items: start;
	}

	.setup-panel {
		position: relative;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: color-mix(in srgb, var(--sig-surface), transparent 5%);
		padding: 16px;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 1px 3px rgba(0, 0, 0, 0.28);
		overflow: hidden;
	}

	.setup-panel::before {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.035), transparent 42%);
	}

	.setup-summary {
		display: none;
	}

	.summary-readout {
		position: relative;
		padding-right: 16px;
		border-right: 1px solid var(--sig-border);
	}

	.summary-readout strong {
		display: block;
		margin-top: 8px;
		font-family: var(--font-display, monospace);
		font-size: 26px;
		line-height: 1;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.summary-readout p,
	.summary-note {
		margin-top: 10px;
		font-size: 13px;
		line-height: 1.45;
		color: var(--sig-text-muted);
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
	}

	.summary-grid div {
		padding: 10px 11px;
		border-right: 1px solid var(--sig-border);
	}

	.summary-grid div:last-child {
		border-right: 0;
	}

	.summary-grid strong {
		display: block;
		margin-top: 4px;
		font-family: var(--font-mono, monospace);
		font-size: 15px;
		line-height: 1.1;
		color: var(--sig-text-bright);
		word-break: break-word;
	}

	.identity-panel,
	.next-panel {
		grid-column: 1;
	}

	.memory-panel {
		grid-column: 2;
		grid-row: 1 / span 3;
	}

	.section-head {
		position: relative;
		display: flex;
		gap: 12px;
		align-items: flex-start;
		margin-bottom: 14px;
	}

	.step {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		color: var(--sig-text-bright);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	h3 {
		font-family: var(--font-display, monospace);
		font-size: 14px;
		letter-spacing: 0.09em;
		color: var(--sig-text-bright);
		text-transform: uppercase;
	}

	.section-head p,
	.provider-card small,
	.harness-main small,
	.detail-banner p,
	.empty-hint {
		font-size: 12px;
		line-height: 1.35;
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
		gap: 7px;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	:global(.onboarding-input) {
		border-radius: var(--sig-radius) !important;
		border-color: var(--sig-border-strong) !important;
		background: color-mix(in srgb, var(--sig-bg), transparent 6%) !important;
		color: var(--sig-text-bright) !important;
		font-family: var(--font-mono, monospace) !important;
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.28) !important;
	}

	:global(.onboarding-textarea) {
		min-height: 74px !important;
		resize: vertical;
	}

	.harness-list,
	.provider-detail {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}

	.harness-list {
		max-height: 268px;
		overflow: auto;
		padding-right: 2px;
	}

	.harness-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		cursor: pointer;
	}

	.harness-row-active {
		border-color: var(--sig-highlight-dim);
		background: var(--sig-highlight-muted);
		box-shadow: inset 3px 0 0 var(--sig-highlight), inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border: 1px solid var(--sig-text-muted);
		background: transparent;
		flex: 0 0 auto;
	}

	.status-dot-installed {
		border-color: var(--sig-success);
		background: var(--sig-success);
		box-shadow: 0 0 8px color-mix(in srgb, var(--sig-success), transparent 40%);
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
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 9px;
		margin-bottom: 12px;
	}

	.provider-group-title {
		grid-column: 1 / -1;
		margin: 2px 0 -2px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.provider-group-title-secondary {
		margin-top: 8px;
		color: var(--sig-text-muted);
	}

	.provider-card-compact {
		min-height: 72px;
	}

	.provider-card-compact small {
		display: none;
	}

	.provider-card {
		min-height: 78px;
		padding: 12px;
		text-align: left;
		color: var(--sig-text);
		cursor: pointer;
	}

	.provider-card strong {
		display: block;
		margin: 7px 0 6px;
		font-family: var(--font-display, monospace);
		font-size: 13px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.provider-card-active {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 10%);
		box-shadow: var(--sig-glow-highlight), inset 3px 0 0 var(--sig-highlight), inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	.provider-mode {
		color: var(--sig-highlight-text);
	}

	.detail-banner {
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 10px 12px;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: var(--sig-bg);
	}

	.detail-banner span {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.choice-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.preset-row {
		padding-top: 2px;
	}

	.choice-pill {
		padding: 7px 10px;
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		color: var(--sig-text);
		cursor: pointer;
	}

	.choice-pill-active {
		border-color: var(--sig-highlight);
		color: var(--sig-text-bright);
		background: var(--sig-highlight-muted);
	}

	.inline-toggle {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 10px;
		font-size: 12px;
		color: var(--sig-text);
		cursor: pointer;
	}

	.next-panel {
		background: color-mix(in srgb, var(--sig-surface), var(--sig-success) 4%);
	}

	.next-row .choice-pill:first-child {
		border-color: color-mix(in srgb, var(--sig-success), var(--sig-border-strong) 35%);
	}

	.onboarding-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 22px;
		background: var(--sig-surface);
	}

	.action-cluster {
		display: flex;
		gap: 10px;
	}

	@media (max-width: 980px) {
		.onboarding-body,
		.setup-main,
		.field-grid,
		.provider-grid {
			grid-template-columns: 1fr;
		}

		.setup-summary {
			position: relative;
			min-height: auto;
		}

		.identity-panel,
		.memory-panel,
		.next-panel {
			grid-column: auto;
			grid-row: auto;
		}
	}

	@media (max-width: 620px) {
		.onboarding-backdrop {
			padding: 8px;
		}

		.onboarding-header {
			padding: 22px 18px 18px;
		}

		.header-coordinate,
		.progress-rail,
		.setup-summary {
			display: none;
		}

		.onboarding-body {
			padding: 10px;
		}

		.onboarding-actions {
			align-items: stretch;
			flex-direction: column;
		}

		.action-cluster {
			justify-content: flex-end;
		}
	}
</style>
