import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";
import type { InstalledMarketplaceMcpServer } from "./marketplace.js";

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

function getInstalledMcpPath(): string {
	return join(getAgentsDir(), "marketplace", "mcp-servers.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function readInstalledServersPublic(): InstalledMarketplaceMcpServer[] {
	const path = getInstalledMcpPath();
	if (!existsSync(path)) return [];

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(item): item is InstalledMarketplaceMcpServer =>
				isRecord(item) &&
				typeof item.id === "string" &&
				typeof item.name === "string" &&
				typeof item.enabled === "boolean",
		);
	} catch {
		return [];
	}
}
