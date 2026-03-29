import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
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

function resolveOhMyPiExtensionsDir(home = homedir()): string {
	const configuredAgentDir = readTrimmedEnv("PI_CODING_AGENT_DIR");
	const agentDir = configuredAgentDir ?? join(home, ".omp", "agent");
	return join(agentDir, "extensions");
}

function resolveWorkspacePath(home = homedir()): string {
	const configured = readTrimmedEnv("SIGNET_PATH");
	if (configured) return configured;

	const workspaceConfigPath = join(home, ".config", "signet", "workspace.json");
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
	if (__signetRuntimeEnv && typeof __signetRuntimeEnv === "object") {
		if (typeof Reflect.get(__signetRuntimeEnv, "SIGNET_PATH") !== "string") {
			Reflect.set(__signetRuntimeEnv, "SIGNET_PATH", ${workspace});
		}
		if (typeof Reflect.get(__signetRuntimeEnv, "SIGNET_DAEMON_URL") !== "string") {
			Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", ${daemonUrl});
		}
		if (typeof Reflect.get(__signetRuntimeEnv, "SIGNET_AGENT_ID") !== "string") {
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

export class OhMyPiConnector extends BaseConnector {
	readonly name = "Oh My Pi";
	readonly harnessId = "oh-my-pi";

	private getManagedExtensionPath(): string {
		return join(resolveOhMyPiExtensionsDir(), OH_MY_PI_MANAGED_FILENAME);
	}

	private getLegacyManagedExtensionPath(): string {
		return join(resolveOhMyPiExtensionsDir(), OH_MY_PI_LEGACY_MANAGED_FILENAME);
	}

	getConfigPath(): string {
		return this.getManagedExtensionPath();
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const targetPath = this.getManagedExtensionPath();
		const legacyPath = this.getLegacyManagedExtensionPath();

		if (existsSync(targetPath) && !isSignetManagedExtensionFile(targetPath)) {
			throw new Error(
				`Refusing to overwrite unmanaged Oh My Pi extension at ${targetPath}. Move or remove it first, then rerun setup.`,
			);
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

		if (existsSync(legacyPath) && isSignetManagedExtensionFile(legacyPath)) {
			rmSync(legacyPath, { force: true });
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
		for (const path of [this.getManagedExtensionPath(), this.getLegacyManagedExtensionPath()]) {
			if (existsSync(path) && isSignetManagedExtensionFile(path)) {
				rmSync(path, { force: true });
				filesRemoved.push(path);
			}
		}

		return { filesRemoved };
	}

	isInstalled(): boolean {
		return [this.getManagedExtensionPath(), this.getLegacyManagedExtensionPath()].some((path) =>
			isSignetManagedExtensionFile(path),
		);
	}
}
