import type { ConfigFile } from "$lib/api";
import {
	type AcpxDashboardAgent,
	applyRecommendedPipelineSetup,
} from "$lib/components/tabs/settings/pipeline-settings";
import {
	IDENTITY_PRESETS,
	type IdentityContextFileEntry,
	type IdentityPresetName,
	type IdentitySpecialFileEntry,
} from "@signet/core/identity-presets";
import type { PipelineProviderChoice } from "@signet/core/pipeline-providers";
import {
	EMBEDDING_PROVIDER_OPTIONS,
	EXTRACTION_PROVIDER_OPTIONS,
	type EmbeddingProvider,
	type OnboardingState,
} from "./onboarding-state.svelte";

export type OnboardingConfig = Record<string, unknown>;

function ensureRecord(root: OnboardingConfig, key: string): OnboardingConfig {
	const existing = root[key];
	if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
		return existing as OnboardingConfig;
	}
	const next: OnboardingConfig = {};
	root[key] = next;
	return next;
}

function cloneStartup(entries: readonly IdentityContextFileEntry[]): IdentityContextFileEntry[] {
	return entries.map((entry) => ({ ...entry }));
}

function cloneSpecial(entries: readonly IdentitySpecialFileEntry[]): IdentitySpecialFileEntry[] {
	return entries.map((entry) => ({ ...entry }));
}

export function identityPresetEntries(preset: IdentityPresetName): {
	readonly startup: IdentityContextFileEntry[];
	readonly special: IdentitySpecialFileEntry[];
} {
	const spec = IDENTITY_PRESETS[preset] ?? IDENTITY_PRESETS.minimal;
	return {
		startup: cloneStartup(spec.startup),
		special: cloneSpecial(spec.special),
	};
}

export function identityFileNamesForPreset(preset: IdentityPresetName): string[] {
	const entries = identityPresetEntries(preset);
	return Array.from(
		new Set([...entries.startup, ...entries.special].map((entry) => String(entry.path)).filter(Boolean)),
	);
}

export function missingIdentityFiles(configFiles: readonly ConfigFile[], preset: IdentityPresetName): string[] {
	const existing = new Set(configFiles.map((file) => file.name));
	return identityFileNamesForPreset(preset).filter((name) => !existing.has(name));
}

export function defaultIdentityFileContent(fileName: string, agentName: string): string {
	const title = fileName.replace(/\.md$/i, "");
	return `# ${title}\n\n${agentName || "My Agent"} identity context. Update this file to personalize the agent.\n`;
}

export function getEmbeddingDimensions(model: string): number {
	switch (model) {
		case "all-minilm":
			return 384;
		case "mxbai-embed-large":
			return 1024;
		case "text-embedding-3-large":
			return 3072;
		case "text-embedding-3-small":
			return 1536;
		default:
			return 768;
	}
}

export function isHttpEndpoint(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return true;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function extractionNeedsEndpoint(provider: PipelineProviderChoice): boolean {
	const mode = EXTRACTION_PROVIDER_OPTIONS.find((option) => option.value === provider)?.mode;
	return mode === "local" || mode === "api";
}

export function validateOnboardingStep(state: OnboardingState, step: number): string[] {
	if (step === 1) {
		const errors: string[] = [];
		if (!state.agentName.trim()) errors.push("Agent name is required.");
		if (state.selectedHarnesses.length === 0) errors.push("Select at least one harness.");
		return errors;
	}
	if (step === 2) {
		if (state.embeddingProvider === "none") return [];
		if (!state.embeddingModel.trim()) return ["Embedding model is required."];
		if (!isHttpEndpoint(state.embeddingEndpoint)) return ["Embedding endpoint must be an http:// or https:// URL."];
		return [];
	}
	if (step === 3) {
		if (state.extractionProvider === "none") return [];
		if (!state.extractionModel.trim()) return ["Extraction model is required."];
		if (extractionNeedsEndpoint(state.extractionProvider) && !isHttpEndpoint(state.extractionEndpoint)) {
			return ["Endpoint must be an http:// or https:// URL."];
		}
		return [];
	}
	return [];
}

export function validateOnboardingState(state: OnboardingState): string[] {
	return [1, 2, 3].flatMap((step) => validateOnboardingStep(state, step));
}

function selectedAcpxAgent(harness: string): AcpxDashboardAgent | undefined {
	return harness === "codex" || harness === "claude-code" || harness === "opencode" ? harness : undefined;
}

export function applyOnboardingConfig(agentConfig: OnboardingConfig, state: OnboardingState): void {
	const agent = ensureRecord(agentConfig, "agent");
	agent.name = state.agentName.trim() || "My Agent";
	agent.description = state.agentDescription.trim() || "Personal AI assistant";

	const identity = ensureRecord(agentConfig, "identity");
	const entries = identityPresetEntries(state.identityPreset);
	identity.preset = state.identityPreset;
	identity.startup = { load: entries.startup };
	identity.special = entries.special;
	agentConfig.harnesses = state.selectedHarnesses;

	applyEmbeddingConfig(agentConfig, state.embeddingProvider, state.embeddingModel, state.embeddingEndpoint);
	const acpxAgent = state.extractionProvider === "acpx" ? selectedAcpxAgent(state.selectedHarness) : undefined;
	applyRecommendedPipelineSetup(agentConfig, {
		provider: state.extractionProvider,
		model: state.extractionModel,
		endpoint: extractionNeedsEndpoint(state.extractionProvider) ? state.extractionEndpoint : "",
		agent: acpxAgent,
		acpxHarness: acpxAgent ?? "",
		synthesisEnabled: state.synthesisEnabled,
	});
}

function applyEmbeddingConfig(
	agentConfig: OnboardingConfig,
	provider: EmbeddingProvider,
	modelValue: string,
	endpointValue: string,
): void {
	if (provider === "none") {
		agentConfig.embedding = undefined;
		return;
	}
	const option = EMBEDDING_PROVIDER_OPTIONS.find((item) => item.value === provider);
	const model = modelValue.trim() || option?.defaultModel || "nomic-embed-text-v1.5";
	const endpoint = endpointValue.trim();
	const embedding: OnboardingConfig = {
		provider,
		model,
		dimensions: getEmbeddingDimensions(model),
	};
	if (endpoint) embedding.base_url = endpoint;
	agentConfig.embedding = embedding;
}
