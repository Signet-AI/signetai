import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	MANAGED_AGENT_ID_DEFAULT,
	MANAGED_DAEMON_URL_DEFAULT,
	type UninstallResult,
	buildManagedExtensionContent,
	isManagedExtensionFile,
	managedExtensionFilePath,
	removeManagedExtensionFile,
	resolveSignetAgentId,
	resolveSignetApiKey,
	resolveSignetDaemonUrl,
	resolveSignetWorkspacePath,
} from "@signet/connector-base";
import {
	clearConfiguredOhMyPiAgentDir,
	expandHome,
	getOhMyPiConfigPath,
	listOhMyPiAgentDirCandidates,
	resolveOhMyPiAgentDir,
	resolveOhMyPiExtensionsDir,
	writeConfiguredOhMyPiAgentDir,
} from "@signet/core";
import { EXTENSION_BUNDLE } from "./extension-bundle.js";

const OH_MY_PI_EXTENSION_PACKAGE = "@signet/oh-my-pi-extension";
const OH_MY_PI_EXTENSION_ENTRY = "dist/signet-oh-my-pi.mjs";
const OH_MY_PI_MANAGED_FILENAME = "signet-oh-my-pi.js";
const OH_MY_PI_LEGACY_MANAGED_FILENAME = "signet-oh-my-pi.mjs";
const OH_MY_PI_MANAGED_MARKER = "SIGNET_MANAGED_OH_MY_PI_EXTENSION";

function buildManagedOhMyPiExtensionContent(env: {
	readonly signetPath: string;
	readonly daemonUrl: string;
	readonly agentId: string;
	readonly apiKey?: string;
}): string {
	return buildManagedExtensionContent({
		bundle: EXTENSION_BUNDLE,
		marker: OH_MY_PI_MANAGED_MARKER,
		packageName: OH_MY_PI_EXTENSION_PACKAGE,
		entry: OH_MY_PI_EXTENSION_ENTRY,
		env,
	});
}

export class OhMyPiConnector extends BaseConnector {
	readonly name = "Oh My Pi";
	readonly harnessId = "oh-my-pi";

	private getManagedExtensionPath(): string {
		return join(resolveOhMyPiExtensionsDir(), OH_MY_PI_MANAGED_FILENAME);
	}

	private getLegacyManagedExtensionPath(): string {
		return join(resolveOhMyPiExtensionsDir(), OH_MY_PI_LEGACY_MANAGED_FILENAME);
	}

	private getManagedCandidatePaths(filename: string): readonly string[] {
		return listOhMyPiAgentDirCandidates().map((agentDir) => managedExtensionFilePath(agentDir, filename));
	}

	getConfigPath(): string {
		return this.getManagedExtensionPath();
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const expandedBasePath = expandHome(basePath || resolveSignetWorkspacePath());
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}
		const agentDir = resolveOhMyPiAgentDir();
		const targetPath = managedExtensionFilePath(agentDir, OH_MY_PI_MANAGED_FILENAME);
		const legacyPath = managedExtensionFilePath(agentDir, OH_MY_PI_LEGACY_MANAGED_FILENAME);

		if (existsSync(targetPath) && !isManagedExtensionFile(targetPath, OH_MY_PI_MANAGED_MARKER)) {
			throw new Error(
				`Refusing to overwrite unmanaged Oh My Pi extension at ${targetPath}. Move or remove it first, then rerun setup.`,
			);
		}

		for (const filePath of this.getManagedCandidatePaths(OH_MY_PI_MANAGED_FILENAME)) {
			if (filePath === targetPath) continue;
			removeManagedExtensionFile(filePath, OH_MY_PI_MANAGED_MARKER);
		}
		for (const filePath of this.getManagedCandidatePaths(OH_MY_PI_LEGACY_MANAGED_FILENAME)) {
			if (filePath === legacyPath) continue;
			removeManagedExtensionFile(filePath, OH_MY_PI_MANAGED_MARKER);
		}

		mkdirSync(dirname(targetPath), { recursive: true });
		const managedContent = buildManagedOhMyPiExtensionContent({
			signetPath: expandedBasePath,
			daemonUrl: resolveSignetDaemonUrl() || MANAGED_DAEMON_URL_DEFAULT,
			agentId: resolveSignetAgentId(),
			apiKey: resolveSignetApiKey(),
		});
		const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
		if (previous !== managedContent) {
			writeFileSync(targetPath, managedContent, "utf8");
			filesWritten.push(targetPath);
		}

		removeManagedExtensionFile(legacyPath, OH_MY_PI_MANAGED_MARKER);

		const configPath = getOhMyPiConfigPath();
		const previousConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
		writeConfiguredOhMyPiAgentDir(agentDir);
		const nextConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
		if (previousConfig !== nextConfig) {
			filesWritten.push(configPath);
		}

		return {
			success: true,
			message:
				filesWritten.length > 0 ? "Oh My Pi extension installed successfully" : "Oh My Pi extension already up to date",
			filesWritten,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		for (const path of [
			...this.getManagedCandidatePaths(OH_MY_PI_MANAGED_FILENAME),
			...this.getManagedCandidatePaths(OH_MY_PI_LEGACY_MANAGED_FILENAME),
		]) {
			if (removeManagedExtensionFile(path, OH_MY_PI_MANAGED_MARKER)) {
				filesRemoved.push(path);
			}
		}

		const configPath = getOhMyPiConfigPath();
		if (existsSync(configPath)) {
			clearConfiguredOhMyPiAgentDir();
			if (!existsSync(configPath)) {
				filesRemoved.push(configPath);
			}
		}

		return { filesRemoved };
	}

	isInstalled(): boolean {
		return [
			...this.getManagedCandidatePaths(OH_MY_PI_MANAGED_FILENAME),
			...this.getManagedCandidatePaths(OH_MY_PI_LEGACY_MANAGED_FILENAME),
		].some((path) => isManagedExtensionFile(path, OH_MY_PI_MANAGED_MARKER));
	}
}
