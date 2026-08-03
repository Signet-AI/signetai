import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { PackageManagerFamily } from "./package-manager";
import { inferPackageManagerFromExecutable, normalizeExecutablePath, pathIsWithin } from "./package-manager-path";

const PACKAGE_MANAGERS: readonly PackageManagerFamily[] = ["npm", "pnpm", "bun", "yarn"];

export type SignetInstallMethod = "native" | PackageManagerFamily;

export interface SignetInstallation {
	readonly method: SignetInstallMethod;
	readonly executablePath: string;
	readonly packagePath?: string;
	readonly active: boolean;
	readonly removalCommand?: string;
}

export type SignetUpdateTarget =
	| {
			readonly kind: "native";
			readonly executablePath: string;
	  }
	| {
			readonly kind: "package-manager";
			readonly family: PackageManagerFamily;
			readonly executablePath: string;
	  }
	| {
			readonly kind: "unsupported";
			readonly executablePath: string;
			readonly reason: string;
	  };

export interface SignetInstallationReport {
	readonly target: SignetUpdateTarget;
	readonly installations: readonly SignetInstallation[];
	readonly inactive: readonly SignetInstallation[];
}

interface SignetInstallationDetectionOptions {
	readonly execPath?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly platform?: NodeJS.Platform;
	readonly exists?: (path: string) => boolean;
	readonly realpath?: (path: string) => string;
	readonly pathValue?: string;
}

interface ExecutableCandidate {
	readonly executablePath: string;
	readonly realPath: string;
	readonly method: PackageManagerFamily | null;
	readonly packagePath?: string;
}

function safeRealpath(path: string, platform: NodeJS.Platform, realpath: (path: string) => string): string {
	try {
		return normalizeExecutablePath(realpath(path), platform);
	} catch {
		return normalizeExecutablePath(path, platform);
	}
}

function packagePathFromExecutable(realPath: string, platform: NodeJS.Platform): string | undefined {
	const pathApi = platform === "win32" ? win32 : posix;
	const executableDir = pathApi.dirname(realPath);
	return pathApi.basename(executableDir).toLowerCase() === "bin" &&
		pathApi.basename(pathApi.dirname(executableDir)).toLowerCase() === "signetai"
		? pathApi.dirname(executableDir)
		: undefined;
}

function runtimeExecutable(path: string, platform: NodeJS.Platform): boolean {
	const name = (platform === "win32" ? win32 : posix).basename(path).toLowerCase();
	return name === "node" || name === "node.exe" || name === "bun" || name === "bun.exe";
}

function executableNames(platform: NodeJS.Platform): readonly string[] {
	return platform === "win32" ? ["signet.exe", "signet.cmd", "signet"] : ["signet"];
}

function candidatePaths(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, pathValue: string): string[] {
	const pathApi = platform === "win32" ? win32 : posix;
	const separator = platform === "win32" ? ";" : ":";
	const paths = pathValue
		.split(separator)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.flatMap((entry) => executableNames(platform).map((name) => pathApi.join(entry, name)));

	const nativeName = platform === "win32" ? "signet.exe" : "signet";
	paths.push(
		platform === "win32"
			? pathApi.join(env.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local"), "Programs", "Signet", nativeName)
			: pathApi.join(home, ".local", "bin", nativeName),
	);
	if (env.SIGNET_DIR?.trim()) paths.push(pathApi.join(env.SIGNET_DIR, "bin", nativeName));
	return [...new Set(paths)];
}

export function packageManagerRemovalCommand(family: PackageManagerFamily): string {
	switch (family) {
		case "npm":
			return "npm uninstall -g signetai";
		case "bun":
			return "bun remove -g signetai";
		case "pnpm":
			return "pnpm remove -g signetai";
		case "yarn":
			return "yarn global remove signetai";
	}
}

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function packageManagerEntryPointRemovalCommand(path: string, platform: NodeJS.Platform): string {
	if (platform === "win32") {
		return `del /f /q "${path.replaceAll('"', '""')}"`;
	}
	return `rm -f -- ${quotePosix(path)}`;
}

export function detectSignetInstallations(options: SignetInstallationDetectionOptions = {}): SignetInstallationReport {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const platform = options.platform ?? process.platform;
	const activeExecutablePath = options.execPath ?? process.execPath;
	const pathExists = options.exists ?? existsSync;
	const realpath = options.realpath ?? realpathSync;
	const activeRealPath = safeRealpath(activeExecutablePath, platform, realpath);
	const signetDir = env.SIGNET_DIR?.trim();
	const activeMethod = inferPackageManagerFromExecutable(activeExecutablePath, {
		realPath: activeRealPath,
		env,
		home,
		platform,
	});

	const candidates = candidatePaths(env, home, platform, options.pathValue ?? env.PATH ?? "")
		.filter(pathExists)
		.map((executablePath): ExecutableCandidate => {
			const realPath = safeRealpath(executablePath, platform, realpath);
			return {
				executablePath,
				realPath,
				method: inferPackageManagerFromExecutable(executablePath, { realPath, env, home, platform }),
				packagePath: packagePathFromExecutable(realPath, platform),
			};
		})
		.filter(
			(candidate, index, all) =>
				all.findIndex((other) => other.realPath === candidate.realPath) === index &&
				candidate.realPath !== activeRealPath,
		);

	const activePackagePath = packagePathFromExecutable(activeRealPath, platform);
	const activeInstallation: SignetInstallation = {
		method: activeMethod ?? "native",
		executablePath: activeExecutablePath,
		...(activePackagePath ? { packagePath: activePackagePath } : {}),
		active: true,
		...(activeMethod ? { removalCommand: packageManagerRemovalCommand(activeMethod) } : {}),
	};
	const secondaryInstallations = candidates.flatMap((candidate): SignetInstallation[] => {
		const packageRoot = candidate.packagePath
			? (platform === "win32" ? win32 : posix).dirname(candidate.packagePath)
			: null;
		const ownsActive =
			candidate.method === activeMethod &&
			packageRoot !== null &&
			(pathIsWithin(activeRealPath, packageRoot, platform) ||
				(signetDir ? pathIsWithin(signetDir, packageRoot, platform) : false));
		if (ownsActive) return [];

		const method = candidate.method ?? "native";
		return [
			{
				method,
				executablePath: candidate.executablePath,
				...(candidate.packagePath ? { packagePath: candidate.packagePath } : {}),
				active: false,
				...(method !== "native"
					? { removalCommand: packageManagerEntryPointRemovalCommand(candidate.executablePath, platform) }
					: {}),
			},
		];
	});
	const installations = [activeInstallation, ...secondaryInstallations];
	const target: SignetUpdateTarget = runtimeExecutable(activeExecutablePath, platform)
		? {
				kind: "unsupported",
				executablePath: activeExecutablePath,
				reason: "Signet is running from a source runtime rather than an installed compiled binary",
			}
		: activeMethod
			? { kind: "package-manager", family: activeMethod, executablePath: activeExecutablePath }
			: { kind: "native", executablePath: activeExecutablePath };

	return {
		target,
		installations,
		inactive: installations.filter((installation) => !installation.active),
	};
}

export function inactivePackageManagerInstallations(report: SignetInstallationReport): readonly SignetInstallation[] {
	if (report.target.kind !== "native") return [];
	return report.inactive.filter(
		(installation) =>
			PACKAGE_MANAGERS.includes(installation.method as PackageManagerFamily) && installation.removalCommand,
	);
}
