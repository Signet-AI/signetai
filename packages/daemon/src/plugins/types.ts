export type PluginRuntimeLanguageV1 = "typescript" | "rust";
export type PluginRuntimeKindV1 = "bundled-module" | "sidecar" | "wasi";
export type PluginTrustTierV1 = "core" | "verified" | "community" | "local-dev";
export type PluginSourceV1 = "bundled" | "local" | "marketplace";
export type PluginLifecycleStateV1 = "installed" | "blocked" | "active" | "degraded" | "disabled";
export type PluginPromptTargetV1 = "system" | "session-start" | "user-prompt-submit";
export type PluginPromptModeV1 = "append" | "context";
export type PluginHealthStatusV1 = "healthy" | "degraded" | "unhealthy";

export interface PluginRuntimeV1 {
	readonly language: PluginRuntimeLanguageV1;
	readonly kind: PluginRuntimeKindV1;
	readonly entry?: string;
	readonly protocol?: string;
}

export interface PluginCompatibilityV1 {
	readonly signet: string;
	readonly pluginApi: string;
}

export interface PluginCapabilityDocsV1 {
	readonly summary: string;
	readonly description?: string;
}

export interface PluginDocsMetadataV1 {
	readonly homepage?: string;
	readonly readme?: string;
	readonly capabilities: Readonly<Record<string, PluginCapabilityDocsV1>>;
}

export interface PluginMarketplaceMetadataV1 {
	readonly categories?: readonly string[];
	readonly license?: string;
	readonly repository?: string;
	readonly homepage?: string;
	readonly checksum?: string | null;
	readonly signature?: string | null;
}

export interface PluginSurfaceBaseV1 {
	readonly summary: string;
	readonly requiredCapabilities: readonly string[];
}

export interface PluginRouteSummaryV1 extends PluginSurfaceBaseV1 {
	readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	readonly path: string;
}

export interface PluginCommandSummaryV1 extends PluginSurfaceBaseV1 {
	readonly path: readonly string[];
}

export interface PluginToolSummaryV1 extends PluginSurfaceBaseV1 {
	readonly name: string;
	readonly title: string;
}

export interface PluginDashboardSummaryV1 extends PluginSurfaceBaseV1 {
	readonly id: string;
	readonly title: string;
}

export interface PluginSdkSummaryV1 extends PluginSurfaceBaseV1 {
	readonly name: string;
}

export interface PluginConnectorSummaryV1 extends PluginSurfaceBaseV1 {
	readonly id: string;
	readonly title: string;
}

export interface PluginPromptContributionV1 {
	readonly id: string;
	readonly pluginId: string;
	readonly target: PluginPromptTargetV1;
	readonly mode: PluginPromptModeV1;
	readonly priority: number;
	readonly maxTokens: number;
	readonly content: string;
}

export interface PluginPromptSummaryV1 extends PluginSurfaceBaseV1 {
	readonly id: string;
	readonly target: PluginPromptTargetV1;
	readonly mode: PluginPromptModeV1;
	readonly priority: number;
	readonly maxTokens: number;
}

export interface PluginSurfaceSummaryV1 {
	readonly daemonRoutes: readonly PluginRouteSummaryV1[];
	readonly cliCommands: readonly PluginCommandSummaryV1[];
	readonly mcpTools: readonly PluginToolSummaryV1[];
	readonly dashboardPanels: readonly PluginDashboardSummaryV1[];
	readonly sdkClients: readonly PluginSdkSummaryV1[];
	readonly connectorCapabilities: readonly PluginConnectorSummaryV1[];
	readonly promptContributions: readonly PluginPromptSummaryV1[];
}

export interface PluginSurfaceDeclarationsV1 extends PluginSurfaceSummaryV1 {}

export interface PluginManifestV1 {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly publisher: string;
	readonly description: string;
	readonly runtime: PluginRuntimeV1;
	readonly compatibility: PluginCompatibilityV1;
	readonly trustTier: PluginTrustTierV1;
	readonly capabilities: readonly string[];
	readonly surfaces: PluginSurfaceDeclarationsV1;
	readonly marketplace?: PluginMarketplaceMetadataV1;
	readonly docs: PluginDocsMetadataV1;
	readonly promptContributions?: readonly PluginPromptContributionV1[];
}

export interface PluginHealthV1 {
	readonly status: PluginHealthStatusV1;
	readonly message?: string;
	readonly checkedAt: string;
}

export interface PluginRegistryRecordV1 {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly publisher: string;
	readonly source: PluginSourceV1;
	readonly trustTier: PluginTrustTierV1;
	readonly enabled: boolean;
	readonly state: PluginLifecycleStateV1;
	readonly stateReason?: string;
	readonly declaredCapabilities: readonly string[];
	readonly grantedCapabilities: readonly string[];
	readonly pendingCapabilities: readonly string[];
	readonly surfaces: PluginSurfaceSummaryV1;
	readonly health?: PluginHealthV1;
	readonly installedAt: string;
	readonly updatedAt: string;
}

export interface PluginDiagnosticsV1 {
	readonly record: PluginRegistryRecordV1;
	readonly manifest: PluginManifestV1;
	readonly activeSurfaces: PluginSurfaceSummaryV1;
	readonly plannedSurfaces: PluginSurfaceSummaryV1;
	readonly promptContributions: readonly PluginPromptContributionV1[];
	readonly promptContributionDiagnostics: readonly PluginPromptContributionDiagnosticV1[];
	readonly validationErrors: readonly string[];
}

export interface PluginPromptContributionDiagnosticV1 {
	readonly contribution: PluginPromptContributionV1;
	readonly included: boolean;
	readonly reason?: string;
	readonly missingCapabilities: readonly string[];
}

export type PluginCapabilityCheckStatusV1 = "allowed" | "plugin-not-found" | "plugin-inactive" | "capability-missing";

export interface PluginCapabilityCheckV1 {
	readonly status: PluginCapabilityCheckStatusV1;
	readonly allowed: boolean;
	readonly pluginId: string;
	readonly reason?: string;
	readonly httpStatus: 200 | 403 | 404 | 503;
	readonly missingCapabilities: readonly string[];
}

export interface PluginListResponseV1 {
	readonly plugins: readonly PluginRegistryRecordV1[];
}

export interface PromptContributionListResponseV1 {
	readonly contributions: readonly PluginPromptContributionV1[];
	readonly activeCount: number;
}

export interface PluginDiagnosticsResponseV1 {
	readonly plugin: PluginDiagnosticsV1;
}

export interface PluginUpdateResponseV1 {
	readonly plugin: PluginRegistryRecordV1;
}

export const EMPTY_PLUGIN_SURFACES: PluginSurfaceSummaryV1 = {
	daemonRoutes: [],
	cliCommands: [],
	mcpTools: [],
	dashboardPanels: [],
	sdkClients: [],
	connectorCapabilities: [],
	promptContributions: [],
};
