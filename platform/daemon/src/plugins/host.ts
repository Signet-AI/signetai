import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SIGNET_PLUGIN_REGISTRY_DIR, SIGNET_PLUGIN_REGISTRY_FILE } from "@signet/core";
import { logger } from "../logger.js";
import { truncateToTokens } from "../pipeline/tokenizer.js";
import { recordPluginAuditEvent } from "./audit.js";
import { runtimeSupportedInV1, unsupportedRuntimeReason, validatePluginManifest } from "./manifest.js";
import { EMPTY_PLUGIN_SURFACES } from "./types.js";
import type {
	PluginCapabilityCheckV1,
	PluginDiagnosticsV1,
	PluginHealthV1,
	PluginLifecycleStateV1,
	PluginManifestV1,
	PluginPromptContributionDiagnosticV1,
	PluginPromptContributionV1,
	PluginPromptTargetV1,
	PluginRegistryRecordV1,
	PluginSourceV1,
	PluginSurfaceBaseV1,
	PluginSurfaceSummaryV1,
} from "./types.js";

interface PersistedPluginStateV1 {
	readonly [key: string]: unknown;
	readonly enabled?: boolean;
	readonly grantedCapabilities?: readonly string[];
	readonly installedAt?: string;
	readonly updatedAt?: string;
}

interface PluginRegistryStoreV1 {
	readonly version: 1;
	readonly plugins: Record<string, PersistedPluginStateV1>;
}

interface RegisteredPluginV1 {
	readonly manifest: PluginManifestV1;
	readonly source: PluginSourceV1;
	readonly record: PluginRegistryRecordV1;
	readonly validationErrors: readonly string[];
}

export interface PluginHostOptionsV1 {
	readonly storagePath?: string | null;
	readonly auditPath?: string | null;
	readonly now?: () => Date;
	readonly corePluginIds?: readonly string[];
	readonly persistRegistry?: boolean;
}

export interface DiscoverPluginOptionsV1 {
	readonly source?: PluginSourceV1;
	readonly enabled?: boolean;
	readonly grantedCapabilities?: readonly string[];
	readonly health?: PluginHealthV1;
}

export class PluginHostV1 {
	private readonly storagePath: string | null;
	private readonly auditPath: string | null | undefined;
	private readonly now: () => Date;
	private readonly corePluginIds: readonly string[];
	private readonly persistRegistry: boolean;
	private readonly plugins = new Map<string, RegisteredPluginV1>();
	private storeWritable = true;
	private storeLoadError: string | null = null;
	private store: PluginRegistryStoreV1;

	constructor(opts: PluginHostOptionsV1 = {}) {
		this.storagePath = opts.storagePath === undefined ? getDefaultPluginRegistryPath() : opts.storagePath;
		this.auditPath = opts.auditPath;
		this.now = opts.now ?? (() => new Date());
		this.corePluginIds = opts.corePluginIds ?? [];
		this.persistRegistry = opts.persistRegistry ?? true;
		this.store = this.loadStore();
	}

	discover(manifest: PluginManifestV1, opts: DiscoverPluginOptionsV1 = {}): PluginRegistryRecordV1 {
		const validationErrors = validatePluginManifest(manifest, { corePluginIds: this.corePluginIds });
		const previous = this.store.plugins[manifest.id];
		const timestamp = this.now().toISOString();
		const enabled = previous?.enabled ?? opts.enabled ?? true;
		const requestedCapabilities = previous?.grantedCapabilities ?? opts.grantedCapabilities ?? manifest.capabilities;
		const grantedCapabilities =
			validationErrors.length === 0 && runtimeSupportedInV1(manifest)
				? normalizeCapabilities(
						requestedCapabilities.filter((capability) => manifest.capabilities.includes(capability)),
					)
				: [];
		const installedAt = previous?.installedAt ?? timestamp;
		const updatedAt = timestamp;
		const stateInfo = resolveState(manifest, enabled, opts.health, validationErrors);
		const active = stateInfo.state === "active" || stateInfo.state === "degraded";
		const activeSurfaces = active
			? filterSurfacesByCapabilities(manifest.surfaces, grantedCapabilities)
			: EMPTY_PLUGIN_SURFACES;
		const record: PluginRegistryRecordV1 = {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			publisher: manifest.publisher,
			source: opts.source ?? "bundled",
			trustTier: manifest.trustTier,
			enabled,
			state: stateInfo.state,
			stateReason: stateInfo.stateReason,
			declaredCapabilities: [...manifest.capabilities],
			grantedCapabilities,
			pendingCapabilities: manifest.capabilities.filter((capability) => !grantedCapabilities.includes(capability)),
			surfaces: activeSurfaces,
			health: opts.health,
			installedAt,
			updatedAt,
		};

		this.plugins.set(manifest.id, {
			manifest,
			source: opts.source ?? "bundled",
			record,
			validationErrors,
		});
		this.store = {
			version: 1,
			plugins: {
				...this.store.plugins,
				[manifest.id]: {
					...previous,
					enabled,
					grantedCapabilities,
					installedAt,
					updatedAt,
				},
			},
		};
		this.saveStore();
		recordPluginEvent("plugin.discovered", record, this.auditPath);
		if (record.state === "blocked") {
			recordPluginEvent("plugin.blocked", record, this.auditPath);
		}
		if (opts.health?.status === "unhealthy") {
			recordPluginEvent("plugin.health_failed", record, this.auditPath);
		}
		if (record.state === "degraded") {
			recordPluginEvent("plugin.degraded", record, this.auditPath);
		}
		if (active) {
			recordPromptContributionEvents(
				"prompt.contribution_added",
				record,
				manifest.promptContributions ?? [],
				this.auditPath,
			);
		}
		return record;
	}

	list(): readonly PluginRegistryRecordV1[] {
		return [...this.plugins.values()].map((plugin) => plugin.record).sort((a, b) => a.id.localeCompare(b.id));
	}

	get(id: string): PluginRegistryRecordV1 | undefined {
		return this.plugins.get(id)?.record;
	}

	diagnostics(id: string): PluginDiagnosticsV1 | undefined {
		const plugin = this.plugins.get(id);
		if (!plugin) return undefined;
		return {
			record: plugin.record,
			manifest: plugin.manifest,
			activeSurfaces: plugin.record.surfaces,
			plannedSurfaces: plugin.manifest.surfaces,
			promptContributions: this.promptContributions({ pluginId: id, activeOnly: false }),
			promptContributionDiagnostics: this.promptContributionDiagnostics(id),
			validationErrors: plugin.validationErrors,
		};
	}

	checkCapabilities(pluginId: string, requiredCapabilities: readonly string[]): PluginCapabilityCheckV1 {
		const plugin = this.plugins.get(pluginId);
		if (!plugin) {
			return {
				status: "plugin-not-found",
				allowed: false,
				pluginId,
				reason: "Plugin not found",
				httpStatus: 404,
				missingCapabilities: [...requiredCapabilities],
			};
		}
		const active = plugin.record.state === "active" || plugin.record.state === "degraded";
		if (!active) {
			return {
				status: "plugin-inactive",
				allowed: false,
				pluginId,
				reason: plugin.record.stateReason ?? `Plugin is ${plugin.record.state}`,
				httpStatus: plugin.record.state === "blocked" ? 503 : 403,
				missingCapabilities: [...requiredCapabilities],
			};
		}
		const missingCapabilities = requiredCapabilities.filter(
			(capability) => !plugin.record.grantedCapabilities.includes(capability),
		);
		if (missingCapabilities.length > 0) {
			return {
				status: "capability-missing",
				allowed: false,
				pluginId,
				reason: `Plugin is missing required capabilities: ${missingCapabilities.join(", ")}`,
				httpStatus: 403,
				missingCapabilities,
			};
		}
		return {
			status: "allowed",
			allowed: true,
			pluginId,
			httpStatus: 200,
			missingCapabilities: [],
		};
	}

	setEnabled(id: string, enabled: boolean): PluginRegistryRecordV1 | undefined {
		const plugin = this.plugins.get(id);
		if (!plugin) return undefined;
		const previous = this.store.plugins[id];
		this.store = {
			version: 1,
			plugins: {
				...this.store.plugins,
				[id]: {
					...previous,
					enabled,
					updatedAt: this.now().toISOString(),
				},
			},
		};
		this.saveStore();
		const record = this.discover(plugin.manifest, {
			source: plugin.source,
			grantedCapabilities: plugin.record.grantedCapabilities,
			health: plugin.record.health,
		});
		recordPluginEvent(enabled ? "plugin.enabled" : "plugin.disabled", record, this.auditPath);
		if (!enabled) {
			recordPromptContributionEvents(
				"prompt.contribution_removed",
				record,
				plugin.manifest.promptContributions ?? [],
				this.auditPath,
			);
		}
		return record;
	}

	promptContributions(
		opts: {
			readonly target?: PluginPromptTargetV1;
			readonly pluginId?: string;
			readonly activeOnly?: boolean;
		} = {},
	): readonly PluginPromptContributionV1[] {
		const activeOnly = opts.activeOnly ?? true;
		const contributions: PluginPromptContributionV1[] = [];
		for (const plugin of this.plugins.values()) {
			if (opts.pluginId && plugin.record.id !== opts.pluginId) continue;
			const active = plugin.record.state === "active" || plugin.record.state === "degraded";
			if (activeOnly && !active) continue;
			for (const contribution of plugin.manifest.promptContributions ?? []) {
				if (opts.target && contribution.target !== opts.target) continue;
				const diagnostic = this.promptContributionDiagnostic(plugin, contribution);
				if (activeOnly && !diagnostic.included) continue;
				contributions.push(clipPromptContribution(contribution));
			}
		}
		return contributions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
	}

	private promptContributionDiagnostics(pluginId: string): readonly PluginPromptContributionDiagnosticV1[] {
		const plugin = this.plugins.get(pluginId);
		if (!plugin) return [];
		return (plugin.manifest.promptContributions ?? []).map((contribution) =>
			this.promptContributionDiagnostic(plugin, contribution),
		);
	}

	private promptContributionDiagnostic(
		plugin: RegisteredPluginV1,
		contribution: PluginPromptContributionV1,
	): PluginPromptContributionDiagnosticV1 {
		const active = plugin.record.state === "active" || plugin.record.state === "degraded";
		if (!active) {
			return {
				contribution: clipPromptContribution(contribution),
				included: false,
				reason: plugin.record.stateReason ?? `Plugin is ${plugin.record.state}`,
				missingCapabilities: [],
			};
		}
		const surface = plugin.manifest.surfaces.promptContributions.find((entry) => entry.id === contribution.id);
		if (!surface) {
			return {
				contribution: clipPromptContribution(contribution),
				included: false,
				reason: "Prompt contribution is missing surface metadata",
				missingCapabilities: [],
			};
		}
		const missingCapabilities = surface.requiredCapabilities.filter(
			(capability) => !plugin.record.grantedCapabilities.includes(capability),
		);
		if (missingCapabilities.length > 0) {
			return {
				contribution: clipPromptContribution(contribution),
				included: false,
				reason: `Missing required capabilities: ${missingCapabilities.join(", ")}`,
				missingCapabilities,
			};
		}
		return {
			contribution: clipPromptContribution(contribution),
			included: true,
			missingCapabilities: [],
		};
	}

	private loadStore(): PluginRegistryStoreV1 {
		if (!this.storagePath || !existsSync(this.storagePath)) {
			return { version: 1, plugins: {} };
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.storagePath, "utf-8"));
			return parseStore(parsed);
		} catch (err) {
			this.storeWritable = false;
			this.storeLoadError = err instanceof Error ? err.message : String(err);
			logger.warn("plugins", "plugin registry load failed; persistence disabled to avoid data loss", {
				path: this.storagePath,
				error: this.storeLoadError,
			});
			return { version: 1, plugins: {} };
		}
	}

	private saveStore(): void {
		if (!this.persistRegistry) return;
		if (!this.storagePath) return;
		if (!this.storeWritable) {
			logger.warn("plugins", "plugin registry write skipped because existing registry could not be loaded safely", {
				path: this.storagePath,
				error: this.storeLoadError ?? "unknown registry load error",
			});
			return;
		}
		mkdirSync(dirname(this.storagePath), { recursive: true });
		writeFileSync(this.storagePath, `${JSON.stringify(this.store, null, 2)}\n`, { mode: 0o600 });
	}
}

export function getDefaultPluginRegistryPath(): string {
	return join(
		process.env.SIGNET_PATH || join(homedir(), ".agents"),
		SIGNET_PLUGIN_REGISTRY_DIR,
		SIGNET_PLUGIN_REGISTRY_FILE,
	);
}

function resolveState(
	manifest: PluginManifestV1,
	enabled: boolean,
	health: PluginHealthV1 | undefined,
	validationErrors: readonly string[],
): { readonly state: PluginLifecycleStateV1; readonly stateReason?: string } {
	if (validationErrors.length > 0) {
		return { state: "blocked", stateReason: validationErrors.join("; ") };
	}
	if (!enabled) {
		return { state: "disabled", stateReason: "disabled by host policy" };
	}
	const unsupported = unsupportedRuntimeReason(manifest);
	if (unsupported) {
		return { state: "blocked", stateReason: unsupported };
	}
	if (health?.status === "unhealthy") {
		return { state: "degraded", stateReason: health.message ?? "plugin health check failed" };
	}
	if (health?.status === "degraded") {
		return { state: "degraded", stateReason: health.message ?? "plugin health degraded" };
	}
	return { state: "active" };
}

function normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
	return [...new Set(capabilities)].sort();
}

function filterSurfacesByCapabilities(
	surfaces: PluginSurfaceSummaryV1,
	grantedCapabilities: readonly string[],
): PluginSurfaceSummaryV1 {
	const allowed = (surface: PluginSurfaceBaseV1): boolean =>
		surface.requiredCapabilities.every((capability) => grantedCapabilities.includes(capability));
	return {
		daemonRoutes: surfaces.daemonRoutes.filter(allowed),
		cliCommands: surfaces.cliCommands.filter(allowed),
		mcpTools: surfaces.mcpTools.filter(allowed),
		dashboardPanels: surfaces.dashboardPanels.filter(allowed),
		sdkClients: surfaces.sdkClients.filter(allowed),
		connectorCapabilities: surfaces.connectorCapabilities.filter(allowed),
		promptContributions: surfaces.promptContributions.filter(allowed),
	};
}

function parseStore(value: unknown): PluginRegistryStoreV1 {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.plugins)) {
		throw new Error("expected plugin registry version 1 with a plugins object");
	}
	const plugins: Record<string, PersistedPluginStateV1> = {};
	for (const [id, raw] of Object.entries(value.plugins)) {
		if (!isRecord(raw)) {
			throw new Error(`expected plugin registry entry ${id} to be an object`);
		}
		plugins[id] = {
			...raw,
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			grantedCapabilities: parseStringArray(raw.grantedCapabilities),
			installedAt: typeof raw.installedAt === "string" ? raw.installedAt : undefined,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
		};
	}
	return { version: 1, plugins };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((entry) => typeof entry === "string") ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipPromptContribution(contribution: PluginPromptContributionV1): PluginPromptContributionV1 {
	const maxTokens = Number.isFinite(contribution.maxTokens) ? Math.max(0, Math.trunc(contribution.maxTokens)) : 0;
	const content = truncateToTokens(contribution.content, maxTokens);
	if (content === contribution.content) return contribution;
	return {
		...contribution,
		content,
	};
}

function recordPluginEvent(event: string, record: PluginRegistryRecordV1, auditPath?: string | null): void {
	const data = {
		state: record.state,
		enabled: record.enabled,
		...(record.stateReason ? { stateReason: record.stateReason } : {}),
	};
	recordPluginAuditEvent(
		{
			event,
			pluginId: record.id,
			result: auditResultForRecord(record),
			source: "plugin-host",
			data,
		},
		auditPath,
	);
	logger.info("plugins", event, {
		pluginId: record.id,
		...data,
		timestamp: new Date().toISOString(),
	});
}

function recordPromptContributionEvents(
	event: string,
	record: PluginRegistryRecordV1,
	contributions: readonly PluginPromptContributionV1[],
	auditPath?: string | null,
): void {
	for (const contribution of contributions) {
		const data = {
			contributionId: contribution.id,
			target: contribution.target,
			mode: contribution.mode,
		};
		recordPluginAuditEvent(
			{
				event,
				pluginId: record.id,
				result: auditResultForRecord(record),
				source: "plugin-host",
				data,
			},
			auditPath,
		);
		logger.info("plugins", event, {
			pluginId: record.id,
			...data,
			timestamp: new Date().toISOString(),
		});
	}
}

function auditResultForRecord(record: PluginRegistryRecordV1): "ok" | "denied" | "degraded" {
	if (record.state === "blocked" || record.state === "disabled") return "denied";
	if (record.state === "degraded") return "degraded";
	return "ok";
}
