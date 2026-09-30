const PIPELINE_V2_CONFIG_PATH = ["memory", "pipelineV2"] as const;

export const PIPELINE_V2_CONFIG_ALIASES = {
	graphEnabled: {
		kind: "boolean",
		nestedPath: ["graph", "enabled"],
		defaultValue: true,
		migration: { flatFalseToTrue: true, nestedEnabledFalseToTrue: true },
	},
	rerankerEnabled: {
		kind: "boolean",
		nestedPath: ["reranker", "enabled"],
		defaultValue: true,
		migration: { flatFalseToTrue: true, nestedEnabledFalseToTrue: true },
	},
	rerankerUseExtractionModel: {
		kind: "boolean",
		nestedPath: ["reranker", "useExtractionModel"],
		defaultValue: false,
		migration: { flatFalseToTrue: false, nestedEnabledFalseToTrue: false },
	},
	autonomousEnabled: {
		kind: "boolean",
		nestedPath: ["autonomous", "enabled"],
		defaultValue: true,
		migration: { flatFalseToTrue: true, nestedEnabledFalseToTrue: true },
	},
	autonomousFrozen: {
		kind: "boolean",
		nestedPath: ["autonomous", "frozen"],
		defaultValue: false,
		migration: { flatFalseToTrue: false, nestedEnabledFalseToTrue: false },
	},
	allowUpdateDelete: {
		kind: "boolean",
		nestedPath: ["autonomous", "allowUpdateDelete"],
		defaultValue: true,
		migration: { flatFalseToTrue: true, nestedEnabledFalseToTrue: false },
	},
	maintenanceMode: {
		kind: "maintenanceMode",
		nestedPath: ["autonomous", "maintenanceMode"],
		defaultValue: "execute",
	},
} as const;

export type PipelineV2BooleanAlias = {
	[Key in keyof typeof PIPELINE_V2_CONFIG_ALIASES]: (typeof PIPELINE_V2_CONFIG_ALIASES)[Key] extends {
		readonly kind: "boolean";
	}
		? Key
		: never;
}[keyof typeof PIPELINE_V2_CONFIG_ALIASES];

export const PIPELINE_V2_MAINTENANCE_MODES = ["observe", "execute"] as const;
export type PipelineV2MaintenanceMode = (typeof PIPELINE_V2_MAINTENANCE_MODES)[number];

const pipelineV2AliasEntries = Object.entries(PIPELINE_V2_CONFIG_ALIASES);
const maintenanceModeAliasName = pipelineV2AliasEntries.find(([, alias]) => alias.kind === "maintenanceMode")?.[0];
if (maintenanceModeAliasName === undefined) throw new Error("pipelineV2 maintenanceMode alias is missing");

export const PIPELINE_V2_CONFIG_MIGRATION = {
	flatFalseToTrue: pipelineV2AliasEntries.flatMap(([key, alias]) =>
		alias.kind === "boolean" && alias.migration.flatFalseToTrue ? [key] : [],
	),
	nestedEnabledFalseToTrue: Array.from(
		new Set(
			pipelineV2AliasEntries.flatMap(([, alias]) =>
				alias.kind === "boolean" && alias.migration.nestedEnabledFalseToTrue ? [alias.nestedPath[0]] : [],
			),
		),
	),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function isMaintenanceMode(value: unknown): value is PipelineV2MaintenanceMode {
	return PIPELINE_V2_MAINTENANCE_MODES.some((mode) => mode === value);
}

export function resolvePipelineV2BooleanAlias(config: unknown, aliasName: PipelineV2BooleanAlias): boolean {
	const alias = PIPELINE_V2_CONFIG_ALIASES[aliasName];
	const nestedValue = getPath(config, [...PIPELINE_V2_CONFIG_PATH, ...alias.nestedPath]);
	if (typeof nestedValue === "boolean") return nestedValue;
	const flatValue = getPath(config, [...PIPELINE_V2_CONFIG_PATH, aliasName]);
	if (typeof flatValue === "boolean") return flatValue;
	return alias.defaultValue;
}

export function pipelineV2BooleanAliasPath(config: unknown, aliasName: PipelineV2BooleanAlias): readonly string[] {
	const alias = PIPELINE_V2_CONFIG_ALIASES[aliasName];
	const nestedPath = [...PIPELINE_V2_CONFIG_PATH, ...alias.nestedPath];
	if (typeof getPath(config, nestedPath) === "boolean") return nestedPath;
	const flatPath = [...PIPELINE_V2_CONFIG_PATH, aliasName];
	if (typeof getPath(config, flatPath) === "boolean") return flatPath;
	return nestedPath;
}

export function resolvePipelineV2MaintenanceMode(config: unknown): PipelineV2MaintenanceMode {
	const alias = PIPELINE_V2_CONFIG_ALIASES.maintenanceMode;
	const nestedValue = getPath(config, [...PIPELINE_V2_CONFIG_PATH, ...alias.nestedPath]);
	const flatValue = getPath(config, [...PIPELINE_V2_CONFIG_PATH, maintenanceModeAliasName]);
	const selectedValue = nestedValue ?? flatValue;
	return isMaintenanceMode(selectedValue) ? selectedValue : alias.defaultValue;
}

export function pipelineV2MaintenanceModePath(config: unknown): readonly string[] {
	const alias = PIPELINE_V2_CONFIG_ALIASES.maintenanceMode;
	const nestedPath = [...PIPELINE_V2_CONFIG_PATH, ...alias.nestedPath];
	const nestedValue = getPath(config, nestedPath);
	if (nestedValue !== null && nestedValue !== undefined) return nestedPath;
	return [...PIPELINE_V2_CONFIG_PATH, maintenanceModeAliasName];
}
