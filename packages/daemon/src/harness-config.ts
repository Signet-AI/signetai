import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { parse as parseYaml } from "yaml";

function parseHarnessList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function readHarnessesFromConfigContent(content: string): string[] | null {
	try {
		const parsed = parseYaml(content) as { harnesses?: unknown };
		return parseHarnessList(parsed.harnesses);
	} catch {
		// Fall through to compatibility parser when strict YAML parsing fails
	}

	try {
		const parsed = parseSimpleYaml(content) as { harnesses?: unknown };
		return parseHarnessList(parsed.harnesses);
	} catch {
		return null;
	}
}

export function readEnabledHarnessesFromConfigFiles(agentsDir: string): Set<string> | null {
	const harnessConfigPaths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml")];

	for (const filePath of harnessConfigPaths) {
		if (!existsSync(filePath)) continue;
		try {
			const fileContent = readFileSync(filePath, "utf-8");
			const harnesses = readHarnessesFromConfigContent(fileContent);
			if (!harnesses) continue;

			return new Set(harnesses);
		} catch {
			// Ignore read errors and try the next config path
		}
	}

	return null;
}
