<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import { type ConfigFile, type DaemonStatus, type Harness, type MemoryStats, saveConfigFileResult } from "$lib/api";
	import { Button } from "$lib/components/ui/button/index.js";
	import { applyRecommendedPipelineSetup, resolveSynthesisEnabled } from "$lib/components/tabs/settings/pipeline-settings";
	import { KNOWN_HARNESSES, st } from "$lib/stores/settings.svelte";
	import { toast } from "$lib/stores/toast.svelte";
	import type { TabId } from "$lib/stores/navigation.svelte";
	import { defaultPipelineModel, type PipelineProviderChoice } from "@signet/core/pipeline-providers";
	import { onMount, untrack } from "svelte";
	import { fly } from "svelte/transition";
	import { stringify } from "yaml";
	import {
		type OnboardingState,
		type EmbeddingProvider,
		type IdentityPresetName,
		EMBEDDING_PROVIDER_OPTIONS,
		EXTRACTION_PROVIDER_OPTIONS,
		EXTRACTION_MODEL_PRESETS,
		createDefaultState,
	} from "./onboarding-state.svelte";
	import WelcomeStep from "./steps/WelcomeStep.svelte";
	import IdentityStep from "./steps/IdentityStep.svelte";
	import EmbeddingStep from "./steps/EmbeddingStep.svelte";
	import ExtractionStep from "./steps/ExtractionStep.svelte";
	import ReviewStep from "./steps/ReviewStep.svelte";

	interface Props {
		configFiles: ConfigFile[];
		memoryStats: MemoryStats;
		daemonStatus: DaemonStatus | null;
		harnesses?: Harness[];
		onnavigate?: (tab: TabId) => void;
	}

	const { configFiles, memoryStats, daemonStatus, harnesses = [], onnavigate }: Props = $props();

	const STEPS = [
		{ number: "01", title: "Welcome", subtitle: "Choose an identity preset for your agent." },
		{ number: "02", title: "Identity", subtitle: "Name your agent and select harnesses." },
		{ number: "03", title: "Embeddings", subtitle: "Configure vector search for semantic recall." },
		{ number: "04", title: "Extraction", subtitle: "Pick an extraction route for the memory pipeline." },
		{ number: "05", title: "Review", subtitle: "Confirm your choices before saving." },
	];

	let open = $state(false);
	let initialized = $state(false);
	let forceOpen = false;
	let direction = $state<1 | -1>(1);
	let obState = $state<OnboardingState>(createDefaultState());

	const storageKey = $derived(`signet:onboarding:dismissed:${daemonStatus?.agentsDir ?? "unknown"}`);

	function readPipelineString(...path: string[]): string {
		return st.aStr(["memory", "pipelineV2", ...path]);
	}

	function hydrateFromSettings(): void {
		st.init(configFiles);
		obState.agentName = st.aStr(["agent", "name"]) || st.aStr(["name"]) || "My Agent";
		obState.agentDescription = st.aStr(["agent", "description"]) || st.aStr(["description"]) || "Personal AI assistant";
		obState.identityPreset = (st.aStr(["identity", "preset"]) || "minimal") as IdentityPresetName;

		const harnessFromApi = harnesses.map((h) => h.id || h.name).filter(Boolean);
		const combined = [...new Set([...harnessFromApi, ...KNOWN_HARNESSES])];
		obState.selectedHarnesses = st.harnessArray();
		if (obState.selectedHarnesses.length === 0 && combined.length > 0) {
			obState.selectedHarnesses = [combined[0]];
		}
		obState.selectedHarness = obState.selectedHarnesses[0] ?? "";

		const embProvider = st.sStr([...st.embPath(), "provider"]) || "native";
		obState.embeddingProvider = EMBEDDING_PROVIDER_OPTIONS.some((o) => o.value === embProvider) ? embProvider as EmbeddingProvider : "native";
		obState.embeddingModel =
			st.sStr([...st.embPath(), "model"]) ||
			(EMBEDDING_PROVIDER_OPTIONS.find((o) => o.value === obState.embeddingProvider)?.defaultModel ?? "");
		obState.embeddingEndpoint = st.sStr([...st.embPath(), "base_url"]) || st.sStr([...st.embPath(), "baseurl"]) || "";

		const rawProvider =
			readPipelineString("extractionProvider") || readPipelineString("extraction", "provider");
		obState.extractionProvider = EXTRACTION_PROVIDER_OPTIONS.some((o) => o.value === rawProvider)
			? (rawProvider as PipelineProviderChoice)
			: "acpx";
		obState.extractionModel =
			readPipelineString("extractionModel") ||
			readPipelineString("extraction", "model") ||
			defaultPipelineModel(obState.extractionProvider);
		obState.extractionEndpoint =
			readPipelineString("extraction", "endpoint") ||
			readPipelineString("extractionEndpoint") ||
			readPipelineString("extractionBaseUrl") ||
			"";
		obState.synthesisEnabled = resolveSynthesisEnabled(st.agent);
		initialized = true;
	}

	function isDefaultishWorkspace(): boolean {
		const name = obState.agentName.trim().toLowerCase();
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

	function dismiss(): void {
		forceOpen = false;
		localStorage.setItem(storageKey, "true");
		open = false;
	}

	function openSettings(): void {
		dismiss();
		onnavigate?.("settings");
	}

	function validateStep(step: number): string[] {
		if (step === 1) {
			const errors: string[] = [];
			if (!obState.agentName.trim()) errors.push("Agent name is required.");
			if (obState.selectedHarnesses.length === 0) errors.push("Select at least one harness.");
			return errors;
		}
		if (step === 2) {
			if (obState.embeddingProvider === "none") return [];
			if (!obState.embeddingModel.trim()) return ["Embedding model is required."];
			return [];
		}
		if (step === 3) {
			if (obState.extractionProvider === "none") return [];
			if (!obState.extractionModel.trim()) return ["Extraction model is required."];
			return [];
		}
		return [];
	}

	function nextStep(): void {
		const errors = validateStep(obState.currentStep);
		if (errors.length > 0) {
			toast(errors[0], "error");
			return;
		}
		direction = 1;
		obState.currentStep = Math.min(obState.currentStep + 1, STEPS.length - 1);
	}

	function prevStep(): void {
		direction = -1;
		obState.currentStep = Math.max(obState.currentStep - 1, 0);
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
		if (obState.saving) return;
		obState.saving = true;
		try {
			st.aSetStr(["agent", "name"], obState.agentName.trim() || "My Agent");
			st.aSetStr(["agent", "description"], obState.agentDescription.trim() || "Personal AI assistant");
			st.aSetStr(["identity", "preset"], obState.identityPreset);
			st.set(st.agent, ["harnesses"], obState.selectedHarnesses);

			const needsEndpoint = (() => {
				const mode = EXTRACTION_PROVIDER_OPTIONS.find((o) => o.value === obState.extractionProvider)?.mode;
				return mode === "local" || mode === "api";
			})();

			applyRecommendedPipelineSetup(st.agent, {
				provider: obState.extractionProvider,
				model: obState.extractionModel,
				endpoint: needsEndpoint ? obState.extractionEndpoint : "",
				acpxHarness: obState.extractionProvider === "acpx" ? obState.selectedHarness : "",
				synthesisEnabled: obState.synthesisEnabled,
			});

			st.agent = { ...st.agent };
			await persistOnboardingConfig();
			forceOpen = false;
			localStorage.setItem(storageKey, "true");
			open = false;
			await invalidateAll();
			toast("Setup complete", "success");
			onnavigate?.("sources");
		} finally {
			obState.saving = false;
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
						<span>SETUP_SEQUENCE</span>
						<span class="header-step">{STEPS[obState.currentStep].number} / {String(STEPS.length).padStart(2, "0")}</span>
					</div>
					<h2 id="onboarding-title">Initialize Signet</h2>
					<p class="lede">{STEPS[obState.currentStep].subtitle}</p>
				</div>

				<div class="progress-track">
					{#each STEPS as step, i (i)}
						<button
							type="button"
							class="progress-dot"
							class:progress-dot-active={i === obState.currentStep}
							class:progress-dot-done={i < obState.currentStep}
							disabled={i > obState.currentStep}
							onclick={() => { if (i < obState.currentStep) { direction = -1; obState.currentStep = i; } }}
							aria-label="Go to step {i + 1}: {step.title}"
						>
							{i + 1}
						</button>
						{#if i < STEPS.length - 1}
							<span class="progress-line" class:progress-line-done={i < obState.currentStep}></span>
						{/if}
					{/each}
				</div>

				<button class="icon-button sig-switch" type="button" aria-label="Dismiss onboarding" onclick={dismiss}>
					&times;
				</button>
			</header>

			<div class="onboarding-body">
				{#key obState.currentStep}
					<div class="step-panel" in:fly={{ x: direction * 60, duration: 180 }}>
						{#if obState.currentStep === 0}
							<WelcomeStep state={obState} />
						{:else if obState.currentStep === 1}
							<IdentityStep state={obState} {harnesses} />
						{:else if obState.currentStep === 2}
							<EmbeddingStep state={obState} />
						{:else if obState.currentStep === 3}
							<ExtractionStep state={obState} />
						{:else}
							<ReviewStep state={obState} />
						{/if}
					</div>
				{/key}
			</div>

			<footer class="onboarding-actions sig-panel-footer">
				<div class="secondary-actions">
					<Button variant="ghost" type="button" onclick={openSettings}>Settings</Button>
					<Button variant="ghost" type="button" onclick={dismiss}>Skip for now</Button>
				</div>
				<div class="action-cluster">
					{#if obState.currentStep > 0}
						<Button variant="ghost" type="button" onclick={prevStep}>Back</Button>
					{/if}
					{#if obState.currentStep < STEPS.length - 1}
						<Button type="button" onclick={nextStep}>
							{obState.currentStep === 0 ? "Get started" : "Continue"}
						</Button>
					{:else}
						<Button type="button" onclick={finish} disabled={obState.saving}>
							{obState.saving ? "Saving..." : "Save and continue to sources"}
						</Button>
					{/if}
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
			radial-gradient(ellipse at 80% 85%, color-mix(in srgb, var(--sig-surface-raised), transparent 60%), transparent 50%),
			color-mix(in srgb, var(--sig-bg), transparent 10%);
		backdrop-filter: blur(8px) saturate(0.9);
	}

	.onboarding-modal {
		position: relative;
		width: min(960px, 100%);
		height: min(720px, calc(100vh - 48px));
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
		padding: 18px 30px 15px;
		border-bottom: 1px solid var(--sig-border-strong);
		background:
			linear-gradient(var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(90deg, var(--sig-grid-line) 1px, transparent 1px),
			linear-gradient(135deg, color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 5%), var(--sig-bg) 68%);
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
		max-width: 480px;
	}

	.header-kicker {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.signal-dot {
		width: 7px;
		height: 7px;
		border: 1px solid var(--sig-success);
		background: var(--sig-success);
		box-shadow: 0 0 10px color-mix(in srgb, var(--sig-success), transparent 28%);
	}

	.header-step {
		color: var(--sig-text-muted);
	}

	h2 {
		margin: 0;
		font-family: var(--font-display, monospace);
		font-size: clamp(24px, 3.4vw, 38px);
		line-height: 0.94;
		letter-spacing: 0.06em;
		color: var(--sig-text-bright);
		text-transform: uppercase;
	}

	.lede {
		margin: 7px 0 0;
		font-size: 13px;
		line-height: 1.35;
		color: var(--sig-text);
	}

	.progress-track {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 0;
		margin-top: 12px;
	}

	.progress-dot {
		width: 28px;
		height: 28px;
		display: inline-grid;
		place-items: center;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.05em;
		color: var(--sig-text-muted);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		cursor: pointer;
		transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
			background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
	}

	.progress-dot:hover:not(:disabled) {
		border-color: var(--sig-highlight);
		color: var(--sig-text-bright);
	}

	.progress-dot:disabled {
		cursor: default;
	}

	.progress-dot-active {
		border-color: var(--sig-highlight);
		background: var(--sig-highlight);
		color: var(--sig-bg);
		box-shadow: 0 0 12px color-mix(in srgb, var(--sig-highlight), transparent 32%);
	}

	.progress-dot-done {
		border-color: var(--sig-highlight);
		color: var(--sig-highlight-text);
	}

	.progress-line {
		width: 28px;
		height: 2px;
		background: var(--sig-border-strong);
	}

	.progress-line-done {
		background: var(--sig-highlight);
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

	.onboarding-body {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 24px 30px;
		background:
			radial-gradient(ellipse at 25% 10%, color-mix(in srgb, var(--sig-highlight), transparent 92%), transparent 40%),
			var(--sig-bg);
	}

	.step-panel {
		position: relative;
	}

	.onboarding-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 24px;
	}

	.action-cluster,
	.secondary-actions {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	@media (max-width: 980px) {
		.progress-track {
			display: none;
		}
	}

	@media (max-width: 620px) {
		.onboarding-backdrop {
			padding: 8px;
		}

		.onboarding-modal {
			height: calc(100dvh - 16px);
		}

		.onboarding-header {
			padding: 18px 16px 16px;
			gap: 12px;
		}

		.onboarding-header::after {
			display: none;
		}

		h2 {
			font-size: 24px;
			line-height: 1;
			letter-spacing: 0.04em;
		}

		.lede {
			font-size: 13px;
		}

		.icon-button {
			width: 42px;
			height: 42px;
			flex: 0 0 auto;
		}

		.header-step,
		.progress-track {
			display: none;
		}

		.onboarding-body {
			padding: 16px;
		}

		.onboarding-actions {
			align-items: stretch;
			flex-direction: column;
			padding: 12px;
		}

		.action-cluster,
		.secondary-actions {
			justify-content: space-between;
		}
	}
</style>
