import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_NATIVE_EMBEDDING_IDLE_UNLOAD_MS,
	EDGE_NATIVE_EMBEDDING_IDLE_UNLOAD_MS,
	parseSimpleYaml,
} from "@signet/core";
import { logger } from "./logger";

export type RuntimeProfile = "standard" | "edge";

export interface RuntimeProfileConfig {
	readonly profile: RuntimeProfile;
	readonly embeddingIdleUnloadMs: number;
	readonly embeddingIsolation: "thread" | "process";
	readonly probeEmbeddingAtStartup: boolean;
	readonly watcher: "chokidar" | "poll";
}

const PROFILES: Readonly<Record<RuntimeProfile, RuntimeProfileConfig>> = {
	standard: {
		profile: "standard",
		embeddingIdleUnloadMs: DEFAULT_NATIVE_EMBEDDING_IDLE_UNLOAD_MS,
		embeddingIsolation: "thread",
		probeEmbeddingAtStartup: true,
		watcher: "chokidar",
	},
	edge: {
		profile: "edge",
		embeddingIdleUnloadMs: EDGE_NATIVE_EMBEDDING_IDLE_UNLOAD_MS,
		embeddingIsolation: "process",
		probeEmbeddingAtStartup: false,
		watcher: "poll",
	},
};

function parseProfile(value: unknown): RuntimeProfile | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized === "standard" || normalized === "edge" ? normalized : null;
}

export function loadRuntimeProfile(agentsDir: string, env: NodeJS.ProcessEnv = process.env): RuntimeProfileConfig {
	const envValue = env.SIGNET_RUNTIME_PROFILE;
	if (envValue !== undefined) {
		const profile = parseProfile(envValue);
		if (profile) return PROFILES[profile];
		logger.warn("config", "Ignoring invalid SIGNET_RUNTIME_PROFILE", {
			value: envValue,
			allowed: ["standard", "edge"],
		});
	}

	for (const name of ["agent.yaml", "AGENT.yaml", "config.yaml"]) {
		const path = join(agentsDir, name);
		if (!existsSync(path)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(path, "utf8"));
			const runtime = yaml.runtime as Record<string, unknown> | undefined;
			const raw = runtime?.profile;
			if (raw === undefined) continue;
			const profile = parseProfile(raw);
			if (profile) return PROFILES[profile];
			logger.warn("config", "Ignoring invalid runtime.profile", {
				file: path,
				value: raw,
				allowed: ["standard", "edge"],
			});
			return PROFILES.standard;
		} catch (error) {
			logger.warn("config", "Unable to read runtime profile", {
				file: path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return PROFILES.standard;
}
