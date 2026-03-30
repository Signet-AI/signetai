import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
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
	execPath?: string;
}

const DEFAULT_FALLBACK_ORDER: PackageManagerFamily[] = ["npm", "pnpm", "bun", "yarn"];

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

export function parsePackageManagerUserAgent(userAgent: string | undefined): PackageManagerFamily | null {
	if (!userAgent) return null;
	const firstToken = userAgent.trim().split(/\s+/)[0] || "";
	const familyToken = firstToken.split("/")[0] || firstToken;
	return normalizePackageManager(familyToken);
}

function defaultCommandExists(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
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

/**
 * Detect the package manager that installed the running binary by inspecting
 * the executable path. E.g. `~/.bun/bin/signet` → bun, `/usr/lib/node_modules/` → npm.
 */
function detectFromExecPath(execPath: string | undefined): PackageManagerFamily | null {
	if (!execPath) return null;
	const lower = execPath.replaceAll("\\", "/").toLowerCase();
	if (lower.includes(".bun/") || lower.includes("/bun/")) return "bun";
	if (lower.includes(".pnpm/") || lower.includes("/pnpm/")) return "pnpm";
	if (lower.includes(".yarn/") || lower.includes("/yarn/")) return "yarn";
	// npm global installs go to /usr/lib/node_modules or similar
	if (lower.includes("node_modules")) return "npm";
	return null;
}

function readConfiguredPackageManager(agentsDir: string | undefined): PackageManagerFamily | null {
	if (!agentsDir) return null;

	const configPaths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml"), join(agentsDir, "config.yaml")];

	for (const path of configPaths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(path, "utf-8"));
			const install = yaml.install as Record<string, unknown> | undefined;

			// Skip config values that were auto-detected (source: fallback)
			// rather than explicitly chosen by the user
			const source = install?.source;
			if (source === "fallback") return null;

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

export function resolvePrimaryPackageManager(options: ResolvePackageManagerOptions = {}): PackageManagerResolution {
	const available = detectAvailablePackageManagers(options.commandExists);
	const fallbackOrder = options.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
	const configuredFamily = readConfiguredPackageManager(options.agentsDir);
	const userAgentFamily = parsePackageManagerUserAgent(options.userAgent ?? options.env?.npm_config_user_agent);
	// Try the provided exec path, then process.argv[0], then `which signet`
	let execPathForDetection = options.execPath ?? (typeof process !== "undefined" ? process.argv[0] : undefined);
	if (!detectFromExecPath(execPathForDetection)) {
		try {
			const locator = process.platform === "win32" ? "where" : "which";
			const result = spawnSync(locator, ["signet"], { encoding: "utf-8", windowsHide: true });
			if (result.status === 0 && result.stdout.trim()) {
				execPathForDetection = result.stdout.trim();
			}
		} catch {
			// Ignore — best effort
		}
	}
	const execPathFamily = detectFromExecPath(execPathForDetection);

	const fallbackFamily = pickFirstAvailable(available, fallbackOrder) ?? fallbackOrder[0] ?? "npm";

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

	// Detect from the running binary's install path (e.g. ~/.bun/bin/signet → bun)
	if (execPathFamily && available[execPathFamily]) {
		return {
			family: execPathFamily,
			source: "fallback",
			reason: `Detected package manager '${execPathFamily}' from executable path`,
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

export function getSkillsRunnerCommand(family: PackageManagerFamily, skillsArgs: string[]): PackageManagerCommand {
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

/**
 * Resolve the filesystem path where a globally-installed package lives.
 * Returns undefined if the path cannot be determined or does not exist.
 */
export function resolveGlobalPackagePath(family: PackageManagerFamily, packageName: string): string | undefined {
	try {
		switch (family) {
			case "bun": {
				const bunGlobal = join(
					process.env.BUN_INSTALL ?? join(homedir(), ".bun"),
					"install",
					"global",
					"node_modules",
					packageName,
				);
				if (existsSync(bunGlobal)) return bunGlobal;
				return undefined;
			}
			case "npm": {
				const result = spawnSync("npm", ["root", "-g"], {
					encoding: "utf-8",
					timeout: 10_000,
					windowsHide: true,
				});
				if (result.status === 0 && result.stdout.trim()) {
					const candidate = join(result.stdout.trim(), packageName);
					if (existsSync(candidate)) return candidate;
				}
				return undefined;
			}
			case "pnpm": {
				const result = spawnSync("pnpm", ["root", "-g"], {
					encoding: "utf-8",
					timeout: 10_000,
					windowsHide: true,
				});
				if (result.status === 0 && result.stdout.trim()) {
					const candidate = join(result.stdout.trim(), packageName);
					if (existsSync(candidate)) return candidate;
				}
				return undefined;
			}
			case "yarn": {
				// `yarn global dir` is Yarn Classic (v1) only. Yarn Berry (v2+)
				// removed all `yarn global` subcommands. Detect version first.
				const versionResult = spawnSync("yarn", ["--version"], {
					encoding: "utf-8",
					timeout: 5_000,
					windowsHide: true,
				});
				const isClassic = versionResult.status === 0 && /^1\./.test(versionResult.stdout.trim());

				if (isClassic) {
					const result = spawnSync("yarn", ["global", "dir"], {
						encoding: "utf-8",
						timeout: 10_000,
						windowsHide: true,
					});
					if (result.status === 0 && result.stdout.trim()) {
						const candidate = join(result.stdout.trim(), "node_modules", packageName);
						if (existsSync(candidate)) return candidate;
					}
				} else {
					// Yarn Berry (v2+) removed `yarn global add` entirely, so no
					// global package tree is created under the default linker (PnP).
					// This path only resolves for Berry users who explicitly set
					// `nodeLinker: node-modules` in their .yarnrc.yml — PnP installs
					// will not have a node_modules directory here. Checked as a
					// best-effort fallback; callers should warn when this returns
					// undefined, since Berry users may need an alternative install path.
					const berryGlobal = join(
						process.env.YARN_GLOBAL_FOLDER ?? join(homedir(), ".yarn", "berry", "global"),
						"node_modules",
						packageName,
					);
					if (existsSync(berryGlobal)) return berryGlobal;
				}
				return undefined;
			}
		}
	} catch {
		return undefined;
	}
}

export function getGlobalInstallCommand(family: PackageManagerFamily, packageName: string): PackageManagerCommand {
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
