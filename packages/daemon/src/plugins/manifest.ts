import type { PluginManifestV1, PluginSurfaceBaseV1, PluginSurfaceSummaryV1 } from "./types.js";

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;

export interface PluginValidationOptions {
	readonly corePluginIds?: readonly string[];
}

export function validatePluginManifest(
	manifest: PluginManifestV1,
	opts: PluginValidationOptions = {},
): readonly string[] {
	const errors: string[] = [];
	const corePluginIds = new Set(opts.corePluginIds ?? []);

	if (!PLUGIN_ID_RE.test(manifest.id)) errors.push("id must be dot-delimited lowercase plugin id");
	if (!SEMVER_RE.test(manifest.version)) errors.push("version must be SemVer");
	if (!manifest.name.trim()) errors.push("name is required");
	if (!manifest.publisher.trim()) errors.push("publisher is required");
	if (!manifest.description.trim()) errors.push("description is required");
	if (!manifest.compatibility.signet.trim()) errors.push("compatibility.signet is required");
	if (!manifest.compatibility.pluginApi.trim()) errors.push("compatibility.pluginApi is required");

	if (
		manifest.runtime.kind !== "bundled-module" &&
		manifest.runtime.kind !== "host-managed" &&
		!manifest.runtime.protocol?.trim()
	) {
		errors.push("runtime.protocol is required for sidecar or wasi plugins");
	}

	if (manifest.trustTier === "core" && !corePluginIds.has(manifest.id)) {
		errors.push("only Signet-owned bundled metadata may use trustTier=core");
	}

	const capabilities = new Set(manifest.capabilities);
	if (capabilities.size !== manifest.capabilities.length) {
		errors.push("capabilities must be unique");
	}
	for (const capability of manifest.capabilities) {
		if (!CAPABILITY_RE.test(capability)) {
			errors.push(`capability '${capability}' must be namespace:action shaped`);
		}
		const docs = manifest.docs.capabilities[capability];
		if (!docs?.summary.trim()) {
			errors.push(`capability '${capability}' is missing docs metadata`);
		}
	}

	for (const surface of collectSurfaces(manifest.surfaces)) {
		if (surface.requiredCapabilities.length === 0) {
			errors.push(`surface '${surface.summary}' must require at least one capability`);
		}
		for (const capability of surface.requiredCapabilities) {
			if (!capabilities.has(capability)) {
				errors.push(`surface '${surface.summary}' requires undeclared capability '${capability}'`);
			}
		}
	}

	for (const contribution of manifest.promptContributions ?? []) {
		if (contribution.pluginId !== manifest.id) {
			errors.push(`prompt contribution '${contribution.id}' pluginId must equal manifest id`);
		}
		const surface = manifest.surfaces.promptContributions.find((entry) => entry.id === contribution.id);
		if (!surface) {
			errors.push(`prompt contribution '${contribution.id}' is missing surface metadata`);
		} else {
			if (surface.target !== contribution.target) {
				errors.push(`prompt contribution '${contribution.id}' target must match surface metadata`);
			}
			if (surface.mode !== contribution.mode) {
				errors.push(`prompt contribution '${contribution.id}' mode must match surface metadata`);
			}
		}
		if (contribution.maxTokens < 1) {
			errors.push(`prompt contribution '${contribution.id}' maxTokens must be positive`);
		}
		if (contribution.priority < 0) {
			errors.push(`prompt contribution '${contribution.id}' priority must be non-negative`);
		}
		if (!contribution.content.trim()) {
			errors.push(`prompt contribution '${contribution.id}' content is required`);
		}
	}

	return errors;
}

export function runtimeSupportedInV1(manifest: PluginManifestV1): boolean {
	if (manifest.runtime.kind === "host-managed") {
		return manifest.trustTier === "core" || manifest.trustTier === "verified";
	}
	return (
		manifest.runtime.language === "typescript" &&
		manifest.runtime.kind === "bundled-module" &&
		manifest.trustTier === "core"
	);
}

export function unsupportedRuntimeReason(manifest: PluginManifestV1): string | undefined {
	if (runtimeSupportedInV1(manifest)) return undefined;
	return `unsupported runtime in plugin API V1: language=${manifest.runtime.language}, kind=${manifest.runtime.kind}, trustTier=${manifest.trustTier}`;
}

function collectSurfaces(surfaces: PluginSurfaceSummaryV1): readonly PluginSurfaceBaseV1[] {
	return [
		...surfaces.daemonRoutes,
		...surfaces.cliCommands,
		...surfaces.mcpTools,
		...surfaces.dashboardPanels,
		...surfaces.sdkClients,
		...surfaces.connectorCapabilities,
		...surfaces.promptContributions,
	];
}
