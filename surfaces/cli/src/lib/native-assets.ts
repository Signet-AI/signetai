import { existsSync } from "node:fs";

const ENVIRONMENT_KEYS: Record<string, string> = {
	connectors: "SIGNET_CONNECTOR_ASSETS_DIR",
	graphiq: "SIGNET_GRAPHIQ_ASSETS_DIR",
	skills: "SIGNET_SKILLS_SOURCE",
	templates: "SIGNET_TEMPLATES_DIR",
};

export function materializeEmbeddedAssetTree(kind: string): string | null {
	const key = ENVIRONMENT_KEYS[kind];
	if (key === undefined) return null;
	const directory = process.env[key]?.trim();
	return directory !== undefined && directory.length > 0 && existsSync(directory) ? directory : null;
}
