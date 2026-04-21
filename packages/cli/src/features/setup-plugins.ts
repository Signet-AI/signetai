import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	SIGNET_PLUGIN_REGISTRY_DIR,
	SIGNET_PLUGIN_REGISTRY_FILE,
	SIGNET_PLUGIN_REGISTRY_VERSION,
	SIGNET_SECRETS_PLUGIN_ID,
} from "@signet/core";

export interface CorePluginSetupConfig {
	readonly signetSecretsEnabled: boolean;
}

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

class SetupPluginRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SetupPluginRegistryError";
	}
}

export function getSetupPluginRegistryPath(basePath: string): string {
	return join(basePath, SIGNET_PLUGIN_REGISTRY_DIR, SIGNET_PLUGIN_REGISTRY_FILE);
}

export function readSetupCorePluginEnabled(basePath: string, pluginId = SIGNET_SECRETS_PLUGIN_ID): boolean | null {
	const store = readPluginRegistryOrDefault(basePath);
	const plugin = store.plugins[pluginId];
	return typeof plugin?.enabled === "boolean" ? plugin.enabled : null;
}

export function writeSetupCorePluginRegistry(
	basePath: string,
	config: CorePluginSetupConfig,
	now: Date = new Date(),
): void {
	const path = getSetupPluginRegistryPath(basePath);
	const timestamp = now.toISOString();
	const store = readPluginRegistry(basePath);
	const previous = store.plugins[SIGNET_SECRETS_PLUGIN_ID];
	const next: PluginRegistryStoreV1 = {
		version: SIGNET_PLUGIN_REGISTRY_VERSION,
		plugins: {
			...store.plugins,
			[SIGNET_SECRETS_PLUGIN_ID]: {
				...previous,
				enabled: config.signetSecretsEnabled,
				installedAt: previous?.installedAt ?? timestamp,
				updatedAt: timestamp,
			},
		},
	};

	mkdirSync(join(basePath, SIGNET_PLUGIN_REGISTRY_DIR), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function readPluginRegistryOrDefault(basePath: string): PluginRegistryStoreV1 {
	try {
		return readPluginRegistry(basePath);
	} catch {
		return { version: SIGNET_PLUGIN_REGISTRY_VERSION, plugins: {} };
	}
}

function readPluginRegistry(basePath: string): PluginRegistryStoreV1 {
	const path = getSetupPluginRegistryPath(basePath);
	if (!existsSync(path)) return { version: SIGNET_PLUGIN_REGISTRY_VERSION, plugins: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsePluginRegistry(parsed);
	} catch (err) {
		throw new SetupPluginRegistryError(
			`Refusing to update plugin registry at ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function parsePluginRegistry(value: unknown): PluginRegistryStoreV1 {
	if (!isRecord(value) || value.version !== SIGNET_PLUGIN_REGISTRY_VERSION || !isRecord(value.plugins)) {
		throw new Error(`expected registry version ${SIGNET_PLUGIN_REGISTRY_VERSION} with a plugins object`);
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
	return { version: SIGNET_PLUGIN_REGISTRY_VERSION, plugins };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((entry) => typeof entry === "string") ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
