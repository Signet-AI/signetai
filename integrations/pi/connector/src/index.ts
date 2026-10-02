import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	MANAGED_DAEMON_URL_DEFAULT,
	type UninstallResult,
	buildManagedExtensionContent,
	managedExtensionFilePath,
	resolveSignetAgentId,
	resolveSignetApiKey,
	resolveSignetDaemonUrl,
	resolveSignetWorkspacePath,
} from "@signet/connector-base";
import { createAgentDir } from "@signet/connector-base/agent-dir";
import { EXTENSION_BUNDLE } from "./extension-bundle.js";

const piAgentDir = createAgentDir({
	configFileName: "pi.json",
	defaultAgentDir: ".pi/agent",
	legacyTildeExpansion: true,
});

export const clearConfiguredPiAgentDir = piAgentDir.clearConfiguredAgentDir;
export const getPiConfigPath = piAgentDir.getConfigPath;
export const hasPiSetup = piAgentDir.hasSetup;
export const listPiAgentDirCandidates = piAgentDir.listAgentDirCandidates;
export const readConfiguredPiAgentDir = piAgentDir.readConfiguredAgentDir;
export const resolvePiAgentDir = piAgentDir.resolveAgentDir;
export const resolvePiExtensionsDir = piAgentDir.resolveExtensionsDir;
export const writeConfiguredPiAgentDir = piAgentDir.writeConfiguredAgentDir;

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

	getIconAsset(): string {
		return "pi.svg";
	}

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

		const extensionWritten = this.installManagedExtension({
			targetPath,
			marker: PI_MANAGED_MARKER,
			unmanagedMessage: `Refusing to overwrite unmanaged pi extension at ${targetPath}. Move or remove it first, then rerun setup.`,
			stalePaths: () => this.getManagedCandidatePaths(),
			buildContent: () =>
				buildManagedPiExtensionContent({
					signetPath: basePath || resolveSignetWorkspacePath(),
					daemonUrl: resolveSignetDaemonUrl() || MANAGED_DAEMON_URL_DEFAULT,
					agentId: resolveSignetAgentId(),
					apiKey: resolveSignetApiKey(),
				}),
		});
		if (extensionWritten) filesWritten.push(targetPath);

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
		const filesRemoved = this.removeManagedExtensions(this.getManagedCandidatePaths(), PI_MANAGED_MARKER);

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
		return this.hasManagedExtension(this.getManagedCandidatePaths(), PI_MANAGED_MARKER);
	}
}
