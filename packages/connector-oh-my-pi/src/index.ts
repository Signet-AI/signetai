import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";

const require = createRequire(import.meta.url);

const OH_MY_PI_EXTENSION_PACKAGE = "@signet/oh-my-pi-extension";
const OH_MY_PI_EXTENSION_ENTRY = "dist/signet-oh-my-pi.mjs";
const OH_MY_PI_MANAGED_FILENAME = "signet-oh-my-pi.js";
const OH_MY_PI_LEGACY_MANAGED_FILENAME = "signet-oh-my-pi.mjs";
const OH_MY_PI_MANAGED_MARKER = "SIGNET_MANAGED_OH_MY_PI_EXTENSION";

function resolveOhMyPiExtensionsDir(home = homedir()): string {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir =
		typeof configuredAgentDir === "string" && configuredAgentDir.length > 0
			? configuredAgentDir
			: join(home, ".omp", "agent");
	return join(agentDir, "extensions");
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

function resolveBundledExtensionPath(): string {
	const resolvedEntry = require.resolve(OH_MY_PI_EXTENSION_PACKAGE);
	if (!existsSync(resolvedEntry)) {
		throw new Error(
			`Could not locate the bundled entry for ${OH_MY_PI_EXTENSION_PACKAGE}. Reinstall dependencies and run the extension package build first.`,
		);
	}
	return resolvedEntry;
}

function buildManagedExtensionContent(bundlePath: string): string {
	const bundle = readFileSync(bundlePath, "utf8");
	return `// ${OH_MY_PI_MANAGED_MARKER}
// Managed by Signet (${OH_MY_PI_EXTENSION_PACKAGE})
// Source: ${OH_MY_PI_EXTENSION_ENTRY}
// DO NOT EDIT - this file is overwritten by Signet setup/sync.

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

	async install(_basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const targetPath = this.getManagedExtensionPath();
		const legacyPath = this.getLegacyManagedExtensionPath();

		if (existsSync(targetPath) && !isSignetManagedExtensionFile(targetPath)) {
			throw new Error(
				`Refusing to overwrite unmanaged Oh My Pi extension at ${targetPath}. Move or remove it first, then rerun setup.`,
			);
		}

		mkdirSync(dirname(targetPath), { recursive: true });
		const bundlePath = resolveBundledExtensionPath();
		const managedContent = buildManagedExtensionContent(bundlePath);
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
				filesWritten.length > 0
					? "Oh My Pi extension installed successfully"
					: "Oh My Pi extension already up to date",
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
