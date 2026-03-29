import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
import {
	clearConfiguredOhMyPiAgentDir,
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
const DAEMON_URL_DEFAULT = "http://127.0.0.1:3850";
const AGENT_ID_DEFAULT = "default";

function readTrimmedEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolveWorkspacePath(home = homedir()): string {
	const configured = readTrimmedEnv("SIGNET_PATH");
	if (configured) return configured;

	const configHome = readTrimmedEnv("XDG_CONFIG_HOME") ?? join(home, ".config");
	const workspaceConfigPath = join(configHome, "signet", "workspace.json");
	if (!existsSync(workspaceConfigPath)) return join(home, ".agents");

	try {
		const raw = JSON.parse(readFileSync(workspaceConfigPath, "utf8")) as { workspace?: unknown };
		return typeof raw.workspace === "string" && raw.workspace.trim().length > 0
			? raw.workspace.trim()
			: join(home, ".agents");
	} catch {
		return join(home, ".agents");
	}
}

function resolveDaemonUrl(): string {
	const explicit = readTrimmedEnv("SIGNET_DAEMON_URL");
	if (explicit) return explicit;

	const host = readTrimmedEnv("SIGNET_HOST") ?? "127.0.0.1";
	const port = readTrimmedEnv("SIGNET_PORT") ?? "3850";
	return `http://${host}:${port}`;
}

function resolveAgentId(): string {
	return readTrimmedEnv("SIGNET_AGENT_ID") ?? AGENT_ID_DEFAULT;
}

function isSignetManagedExtensionFile(filePath: string): boolean {
	if (!existsSync(filePath)) return false;
	try {
		const content = readFileSync(filePath, "utf8");
		return content.includes(OH_MY_PI_MANAGED_MARKER);
	} catch {
		return false;
	}
}

function bundledExtensionContent(): string {
	if (EXTENSION_BUNDLE.length === 0) {
		throw new Error(
			`Bundled Oh My Pi extension content is empty. Rebuild ${OH_MY_PI_EXTENSION_PACKAGE} and rerun the connector build so ${OH_MY_PI_EXTENSION_ENTRY} is embedded.`,
		);
	}
	return EXTENSION_BUNDLE;
}

function buildEnvBootstrap(env: {
	readonly signetPath: string;
	readonly daemonUrl: string;
	readonly agentId: string;
}): string {
	const workspace = JSON.stringify(env.signetPath);
	const daemonUrl = JSON.stringify(env.daemonUrl);
	const agentId = JSON.stringify(env.agentId);

	return `const __signetRuntimeProcess = Reflect.get(globalThis, "process");
if (__signetRuntimeProcess && typeof __signetRuntimeProcess === "object") {
	const __signetRuntimeEnv = Reflect.get(__signetRuntimeProcess, "env");
	const __signetReadEnv = (key) => {
		if (!__signetRuntimeEnv || typeof __signetRuntimeEnv !== "object") return undefined;
		const value = Reflect.get(__signetRuntimeEnv, key);
		return typeof value === "string" && value.trim().length > 0 ? value : undefined;
	};
	if (__signetRuntimeEnv && typeof __signetRuntimeEnv === "object") {
		if (!__signetReadEnv("SIGNET_PATH")) {
			Reflect.set(__signetRuntimeEnv, "SIGNET_PATH", ${workspace});
		}
		if (!__signetReadEnv("SIGNET_DAEMON_URL")) {
			Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", ${daemonUrl});
		}
		if (!__signetReadEnv("SIGNET_AGENT_ID")) {
			Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", ${agentId});
		}
	}
}`;
}

function buildManagedExtensionContent(env: {
	readonly signetPath: string;
	readonly daemonUrl: string;
	readonly agentId: string;
}): string {
	const bundle = bundledExtensionContent();
	const bootstrap = buildEnvBootstrap(env);
	return `// ${OH_MY_PI_MANAGED_MARKER}
// Managed by Signet (${OH_MY_PI_EXTENSION_PACKAGE})
// Source: ${OH_MY_PI_EXTENSION_ENTRY}
// DO NOT EDIT - this file is overwritten by Signet setup/sync.

${bootstrap}

${bundle}`;
}

function managedExtensionPath(agentDir: string, filename: string): string {
	return join(agentDir, "extensions", filename);
}

function removeManagedExtensionFile(filePath: string): boolean {
	if (!existsSync(filePath) || !isSignetManagedExtensionFile(filePath)) return false;
	rmSync(filePath, { force: true });
	return true;
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
		return listOhMyPiAgentDirCandidates().map((agentDir) => managedExtensionPath(agentDir, filename));
	}

	getConfigPath(): string {
		return this.getManagedExtensionPath();
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const agentDir = resolveOhMyPiAgentDir();
		const targetPath = managedExtensionPath(agentDir, OH_MY_PI_MANAGED_FILENAME);
		const legacyPath = managedExtensionPath(agentDir, OH_MY_PI_LEGACY_MANAGED_FILENAME);

		if (existsSync(targetPath) && !isSignetManagedExtensionFile(targetPath)) {
			throw new Error(
				`Refusing to overwrite unmanaged Oh My Pi extension at ${targetPath}. Move or remove it first, then rerun setup.`,
			);
		}

		for (const filePath of this.getManagedCandidatePaths(OH_MY_PI_MANAGED_FILENAME)) {
			if (filePath === targetPath) continue;
			removeManagedExtensionFile(filePath);
		}
		for (const filePath of this.getManagedCandidatePaths(OH_MY_PI_LEGACY_MANAGED_FILENAME)) {
			if (filePath === legacyPath) continue;
			removeManagedExtensionFile(filePath);
		}

		mkdirSync(dirname(targetPath), { recursive: true });
		const managedContent = buildManagedExtensionContent({
			signetPath: basePath || resolveWorkspacePath(),
			daemonUrl: resolveDaemonUrl() || DAEMON_URL_DEFAULT,
			agentId: resolveAgentId(),
		});
		const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
		if (previous !== managedContent) {
			writeFileSync(targetPath, managedContent, "utf8");
			filesWritten.push(targetPath);
		}

		removeManagedExtensionFile(legacyPath);

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
			if (removeManagedExtensionFile(path)) {
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
		].some((path) => isSignetManagedExtensionFile(path));
	}
}
