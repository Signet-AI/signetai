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
	clearConfiguredPiAgentDir,
	getPiConfigPath,
	listPiAgentDirCandidates,
	resolvePiAgentDir,
	resolvePiExtensionsDir,
	writeConfiguredPiAgentDir,
} from "@signet/core";
import { EXTENSION_BUNDLE } from "./extension-bundle.js";

const PI_EXTENSION_PACKAGE = "@signet/pi-extension";
const PI_EXTENSION_ENTRY = "dist/signet-pi.mjs";
const PI_MANAGED_FILENAME = "signet-pi.js";
const PI_MANAGED_MARKER = "SIGNET_MANAGED_PI_EXTENSION";

function buildManagedPiExtensionContent(env: {
	readonly signetPath: string;
	readonly daemonUrl: string;
	readonly agentId: string;
	readonly apiKey?: string;
}): string {
	return buildManagedExtensionContent({
		bundle: EXTENSION_BUNDLE,
		marker: PI_MANAGED_MARKER,
		packageName: PI_EXTENSION_PACKAGE,
		entry: PI_EXTENSION_ENTRY,
		env,
	});
}

export class PiConnector extends BaseConnector {
	readonly name = "pi";
	readonly harnessId = "pi";

	private getManagedExtensionPath(): string {
		return join(resolvePiExtensionsDir(), PI_MANAGED_FILENAME);
	}

	private getManagedCandidatePaths(): readonly string[] {
		return listPiAgentDirCandidates().map((agentDir) => managedExtensionFilePath(agentDir, PI_MANAGED_FILENAME));
	}

	getConfigPath(): string {
		return this.getManagedExtensionPath();
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const agentDir = resolvePiAgentDir();
		const targetPath = managedExtensionFilePath(agentDir, PI_MANAGED_FILENAME);

		if (existsSync(targetPath) && !isManagedExtensionFile(targetPath, PI_MANAGED_MARKER)) {
			throw new Error(
				`Refusing to overwrite unmanaged pi extension at ${targetPath}. Move or remove it first, then rerun setup.`,
			);
		}

		for (const filePath of this.getManagedCandidatePaths()) {
			if (filePath === targetPath) continue;
			removeManagedExtensionFile(filePath, PI_MANAGED_MARKER);
		}

		mkdirSync(dirname(targetPath), { recursive: true });
		const managedContent = buildManagedPiExtensionContent({
			signetPath: basePath || resolveSignetWorkspacePath(),
			daemonUrl: resolveSignetDaemonUrl() || MANAGED_DAEMON_URL_DEFAULT,
			agentId: resolveSignetAgentId(),
			apiKey: resolveSignetApiKey(),
		});
		const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
		if (previous !== managedContent) {
			writeFileSync(targetPath, managedContent, "utf8");
			filesWritten.push(targetPath);
		}

		const configPath = getPiConfigPath();
		const previousConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
		writeConfiguredPiAgentDir(agentDir);
		const nextConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
		if (previousConfig !== nextConfig) {
			filesWritten.push(configPath);
		}

		return {
			success: true,
			message: filesWritten.length > 0 ? "pi extension installed successfully" : "pi extension already up to date",
			filesWritten,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		for (const path of this.getManagedCandidatePaths()) {
			if (removeManagedExtensionFile(path, PI_MANAGED_MARKER)) {
				filesRemoved.push(path);
			}
		}

		const configPath = getPiConfigPath();
		if (existsSync(configPath)) {
			clearConfiguredPiAgentDir();
			if (!existsSync(configPath)) {
				filesRemoved.push(configPath);
			}
		}

		return { filesRemoved };
	}

	isInstalled(): boolean {
		return this.getManagedCandidatePaths().some((path) => isManagedExtensionFile(path, PI_MANAGED_MARKER));
	}
}
