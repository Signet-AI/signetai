import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "./yaml";

const CONFIG_FILES = ["agent.yaml", "AGENT.yaml", "config.yaml"] as const;

export function loadConfiguredHarnesses(agentsDir: string): readonly string[] {
	for (const name of CONFIG_FILES) {
		const path = join(agentsDir, name);
		if (!existsSync(path)) continue;

		try {
			const parsed = parseSimpleYaml(readFileSync(path, "utf-8"));
			if (!isRecord(parsed)) return [];
			return parseHarnessList(parsed.harnesses);
		} catch {
			return [];
		}
	}

	return [];
}

export function parseHarnessList(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => (typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []));
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
