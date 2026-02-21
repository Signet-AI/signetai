import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseSimpleYaml } from "./yaml";

export type PackageManagerFamily = "bun" | "npm" | "pnpm" | "yarn";

export interface PackageManagerResolution {
	family: PackageManagerFamily;
	source: "config" | "user-agent" | "fallback";
	reason: string;
	available: Record<PackageManagerFamily, boolean>;
	configuredFamily?: PackageManagerFamily;
	userAgentFamily?: PackageManagerFamily;
}

export interface PackageManagerCommand {
	command: string;
	args: string[];
}

interface ResolvePackageManagerOptions {
	agentsDir?: string;
	env?: Record<string, string | undefined>;
	userAgent?: string;
	fallbackOrder?: PackageManagerFamily[];
	commandExists?: (command: string) => boolean;
}

const DEFAULT_FALLBACK_ORDER: PackageManagerFamily[] = [
	"npm",
	"pnpm",
	"bun",
	"yarn",
];

function normalizePackageManager(value: unknown): PackageManagerFamily | null {
	if (typeof value !== "string") return null;
	const lowered = value.trim().toLowerCase();

	if (lowered === "bun" || lowered === "bunx" || lowered.startsWith("bun/")) {
		return "bun";
	}
	if (lowered === "npm" || lowered === "npx" || lowered.startsWith("npm/")) {
		return "npm";
	}
	if (lowered === "pnpm" || lowered.startsWith("pnpm/")) {
		return "pnpm";
	}
	if (lowered === "yarn" || lowered.startsWith("yarn/")) {
		return "yarn";
	}

	return null;
}

export function parsePackageManagerUserAgent(
	userAgent: string | undefined,
): PackageManagerFamily | null {
	if (!userAgent) return null;
	const firstToken = userAgent.trim().split(/\s+/)[0] || "";
	const familyToken = firstToken.split("/")[0] || firstToken;
	return normalizePackageManager(familyToken);
}

function defaultCommandExists(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "ignore" });
		return result.status === 0;
	} catch {
		return false;
	}
}

export function detectAvailablePackageManagers(
	commandExists: (command: string) => boolean = defaultCommandExists,
): Record<PackageManagerFamily, boolean> {
	return {
		npm: commandExists("npm"),
		pnpm: commandExists("pnpm"),
		bun: commandExists("bun"),
		yarn: commandExists("yarn"),
	};
}

function pickFirstAvailable(
	available: Record<PackageManagerFamily, boolean>,
	order: PackageManagerFamily[],
): PackageManagerFamily | null {
	for (const family of order) {
		if (available[family]) return family;
	}
	return null;
}

function readConfiguredPackageManager(
	agentsDir: string | undefined,
): PackageManagerFamily | null {
	if (!agentsDir) return null;

	const configPaths = [
		join(agentsDir, "agent.yaml"),
		join(agentsDir, "AGENT.yaml"),
		join(agentsDir, "config.yaml"),
	];

	for (const path of configPaths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(path, "utf-8"));
			const install = yaml.install as Record<string, unknown> | undefined;

			const configured =
				normalizePackageManager(install?.primary_package_manager) ||
				normalizePackageManager(install?.package_manager) ||
				normalizePackageManager(yaml.primary_package_manager) ||
				normalizePackageManager(yaml.package_manager);

			if (configured) return configured;
		} catch {
			// Ignore invalid YAML and continue fallback chain.
		}
	}

	return null;
}

export function resolvePrimaryPackageManager(
	options: ResolvePackageManagerOptions = {},
): PackageManagerResolution {
	const available = detectAvailablePackageManagers(options.commandExists);
	const fallbackOrder = options.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
	const configuredFamily = readConfiguredPackageManager(options.agentsDir);
	const userAgentFamily = parsePackageManagerUserAgent(
		options.userAgent ?? options.env?.npm_config_user_agent,
	);

	const fallbackFamily =
		pickFirstAvailable(available, fallbackOrder) ?? fallbackOrder[0] ?? "npm";

	if (configuredFamily && available[configuredFamily]) {
		return {
			family: configuredFamily,
			source: "config",
			reason: `Using configured package manager '${configuredFamily}' from agent config`,
			available,
			configuredFamily,
			userAgentFamily,
		};
	}

	if (configuredFamily && !available[configuredFamily]) {
		return {
			family: fallbackFamily,
			source: "fallback",
			reason: `Configured package manager '${configuredFamily}' is unavailable; using '${fallbackFamily}'`,
			available,
			configuredFamily,
			userAgentFamily,
		};
	}

	if (userAgentFamily && available[userAgentFamily]) {
		return {
			family: userAgentFamily,
			source: "user-agent",
			reason: `Using package manager '${userAgentFamily}' from npm_config_user_agent`,
			available,
			configuredFamily,
			userAgentFamily,
		};
	}

	if (userAgentFamily && !available[userAgentFamily]) {
		return {
			family: fallbackFamily,
			source: "fallback",
			reason: `Package manager '${userAgentFamily}' from npm_config_user_agent is unavailable; using '${fallbackFamily}'`,
			available,
			configuredFamily,
			userAgentFamily,
		};
	}

	return {
		family: fallbackFamily,
		source: "fallback",
		reason: `No package manager metadata found; using '${fallbackFamily}' fallback`,
		available,
		configuredFamily,
		userAgentFamily,
	};
}

export function getSkillsRunnerCommand(
	family: PackageManagerFamily,
	skillsArgs: string[],
): PackageManagerCommand {
	switch (family) {
		case "bun":
			return { command: "bunx", args: ["skills", ...skillsArgs] };
		case "pnpm":
			return { command: "pnpm", args: ["dlx", "skills", ...skillsArgs] };
		case "yarn":
			return { command: "yarn", args: ["dlx", "skills", ...skillsArgs] };
		case "npm":
			return {
				command: "npm",
				args: ["exec", "--yes", "--", "skills", ...skillsArgs],
			};
	}
}

export function getGlobalInstallCommand(
	family: PackageManagerFamily,
	packageName: string,
): PackageManagerCommand {
	switch (family) {
		case "bun":
			return { command: "bun", args: ["add", "-g", packageName] };
		case "pnpm":
			return { command: "pnpm", args: ["add", "-g", packageName] };
		case "yarn":
			return { command: "yarn", args: ["global", "add", packageName] };
		case "npm":
			return { command: "npm", args: ["install", "-g", packageName] };
	}
}
