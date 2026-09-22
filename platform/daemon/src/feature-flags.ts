import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { logger } from "./logger";

let flags: Readonly<Record<string, boolean>> = {};
let initialized = false;

function parseBooleanFlag(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return null;
}

function loadFlags(agentsDir: string): Record<string, boolean> {
	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];

	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(p, "utf-8"));
			const features = yaml.features as Record<string, unknown> | undefined;
			if (!features || typeof features !== "object") continue;

			const result: Record<string, boolean> = {};
			for (const [key, val] of Object.entries(features)) {
				const parsed = parseBooleanFlag(val);
				if (parsed !== null) {
					result[key] = parsed;
				}
			}

			logger.info("config", "Feature flags loaded", {
				count: Object.keys(result).length,
				flags: result,
			});

			return result;
		} catch {}
	}

	return {};
}
export function initFeatureFlags(agentsDir: string): void {
	flags = loadFlags(agentsDir);
	initialized = true;
}
export function getFeatureFlag(name: string): boolean {
	return flags[name] ?? false;
}
export function getAllFeatureFlags(): Readonly<Record<string, boolean>> {
	return flags;
}
