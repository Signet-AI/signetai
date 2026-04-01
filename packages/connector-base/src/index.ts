/**
 * @signet/connector-base
 *
 * Base class for Signet harness connectors. Provides shared functionality
 * that all connectors need (Signet block handling, skills symlinking),
 * allowing concrete connectors to focus on harness-specific logic.
 *
 * @example
 * ```typescript
 * import { BaseConnector, InstallResult } from '@signet/connector-base';
 *
 * class MyConnector extends BaseConnector {
 *   readonly name = "my-harness";
 *   readonly harnessId = "myharness";
 *
 *   async install(basePath: string): Promise<InstallResult> {
 *     // harness-specific setup
 *   }
 *
 *   async uninstall(): Promise<void> {
 *     // harness-specific cleanup
 *   }
 *
 *   isInstalled(): boolean {
 *     // check if already set up
 *   }
 *
 *   getConfigPath(): string {
 *     // return harness config file path
 *   }
 * }
 * ```
 */

import { existsSync, readFileSync, rmSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	stripSignetBlock,
	symlinkSkills,
	type SymlinkOptions,
	type SymlinkResult,
} from "@signet/core";

// ============================================================================
// Types
// ============================================================================

export interface InstallResult {
	success: boolean;
	message: string;
	filesWritten: string[];
	configsPatched?: string[];
	warnings?: string[];
}

export interface UninstallResult {
	filesRemoved: string[];
	configsPatched?: string[];
}

// ============================================================================
// Base Connector
// ============================================================================

/**
 * Abstract base class for Signet harness connectors.
 *
 * Provides:
 * - stripSignetBlock() - remove existing Signet blocks before re-injection
 * - stripLegacySignetBlock() - migrate old SIGNET block out of AGENTS.md
 * - symlinkSkills() - symlink skills directory to harness-specific location
 *
 * Subclasses must implement:
 * - name - human-readable harness name
 * - harnessId - machine identifier for the harness
 * - install() - harness-specific setup
 * - uninstall() - harness-specific cleanup
 * - isInstalled() - check if integration exists
 * - getConfigPath() - return path to harness config
 */
export abstract class BaseConnector {
	/**
	 * Human-readable name for the harness (e.g., "Claude Code")
	 */
	abstract readonly name: string;

	/**
	 * Machine identifier (e.g., "claude-code")
	 */
	abstract readonly harnessId: string;

	// ==========================================================================
	// Shared implementations (provided by base class)
	// ==========================================================================

	/**
	 * Strip existing Signet blocks from content.
	 *
	 * Call this before re-injecting the block to prevent duplication
	 * when re-running install or sync operations.
	 */
	protected stripSignetBlock(content: string): string {
		return stripSignetBlock(content);
	}

	/**
	 * Strip legacy SIGNET block markers from AGENTS.md in place.
	 *
	 * Returns the path when a write occurred, otherwise null.
	 */
	protected stripLegacySignetBlock(basePath: string): string | null {
		const agentsPath = join(basePath, "AGENTS.md");
		if (!existsSync(agentsPath)) return null;
		const raw = readFileSync(agentsPath, "utf-8");
		const cleaned = stripSignetBlock(raw);
		if (cleaned === raw) return null;
		const tmp = join(basePath, `.${randomBytes(6).toString("hex")}.tmp`);
		try {
			writeFileSync(tmp, cleaned, "utf-8");
			renameSync(tmp, agentsPath);
		} catch (err) {
			try { unlinkSync(tmp); } catch {}
			throw err;
		}
		return agentsPath;
	}

	/**
	 * Symlink skills from source to target directory.
	 *
	 * Each subdirectory in sourceDir becomes a symlink in targetDir.
	 * Existing symlinks are replaced; real directories are skipped.
	 */
	protected symlinkSkills(sourceDir: string, targetDir: string, options?: SymlinkOptions): SymlinkResult {
		return symlinkSkills(sourceDir, targetDir, options);
	}

	/**
	 * Generate the auto-generated file header.
	 *
	 * @param sourcePath - Path to the source file being generated from
	 * @param targetName - Name of the target harness
	 */
	protected generateHeader(sourcePath: string, targetName?: string): string {
		const name = targetName || this.name;
		// Strip CR/LF so a malformed path can't break out of comment lines
		const safe = (p: string) => p.replace(/[\n\r]/g, "");
		const root = dirname(sourcePath);
		return `# Auto-generated from ${safe(sourcePath)}
# Source: ${safe(sourcePath)}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ${safe(root)}/ instead

`;
	}

	/**
	 * Read and compose additional identity files (SOUL.md, IDENTITY.md,
	 * USER.md, MEMORY.md) into a single string with section headers.
	 *
	 * @param basePath - Path to the Signet workspace or equivalent identity directory
	 */
	protected composeIdentityExtras(basePath: string): string {
		const files = ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const;
		const parts: string[] = [];

		for (const name of files) {
			const filePath = join(basePath, name);
			if (!existsSync(filePath)) continue;
			try {
				const content = readFileSync(filePath, "utf-8").trim();
				if (!content) continue;
				const header = name.replace(".md", "");
				parts.push(`\n## ${header}\n\n${content}`);
			} catch {
				// Skip unreadable files
			}
		}

		return parts.join("\n");
	}

	// ==========================================================================
	// Abstract methods (must be implemented by subclasses)
	// ==========================================================================

	/**
	 * Install the connector for this harness.
	 *
	 * Should:
	 * - Configure hooks in the harness config
	 * - Generate any necessary files (CLAUDE.md, AGENTS.md, etc.)
	 * - Set up skills symlinks
	 *
	 * Must be idempotent - safe to run multiple times.
	 */
	abstract install(basePath: string): Promise<InstallResult>;

	/**
	 * Remove the connector integration.
	 *
	 * Should:
	 * - Remove hooks from harness config
	 * - Remove generated files (but not user data)
	 * - Optionally remove skills symlinks
	 */
	abstract uninstall(): Promise<UninstallResult>;

	/**
	 * Check if the connector is already installed.
	 */
	abstract isInstalled(): boolean;

	/**
	 * Get the path to the harness's main config file.
	 */
	abstract getConfigPath(): string;
}

// ============================================================================
// Atomic file write — prevents TOCTOU corruption when multiple
// connector runs race on the same config file. Writes to a temp file
// then renames (atomic on POSIX, near-atomic on Windows).
// ============================================================================

export function atomicWriteJson(path: string, data: unknown, indent: number | string = 2): void {
	const content = `${JSON.stringify(data, null, indent)}\n`;
	const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, content, "utf-8");
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw err;
	}
}

// ============================================================================
// Shared managed-extension utilities (used by connector-pi, connector-oh-my-pi)
// ============================================================================

export const MANAGED_DAEMON_URL_DEFAULT = "http://127.0.0.1:3850";
export const MANAGED_AGENT_ID_DEFAULT = "default";

export function readManagedTrimmedEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSignetWorkspacePath(home = homedir()): string {
	const configured = readManagedTrimmedEnv("SIGNET_PATH");
	if (configured) return configured;

	const configHome = readManagedTrimmedEnv("XDG_CONFIG_HOME") ?? join(home, ".config");
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

export function resolveSignetDaemonUrl(): string {
	const explicit = readManagedTrimmedEnv("SIGNET_DAEMON_URL");
	if (explicit) return explicit;

	const host = readManagedTrimmedEnv("SIGNET_HOST") ?? "127.0.0.1";
	const port = readManagedTrimmedEnv("SIGNET_PORT") ?? "3850";
	return `http://${host}:${port}`;
}

export function resolveSignetAgentId(): string {
	return readManagedTrimmedEnv("SIGNET_AGENT_ID") ?? MANAGED_AGENT_ID_DEFAULT;
}

export function buildManagedExtensionEnvBootstrap(env: {
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

export function managedExtensionFilePath(agentDir: string, filename: string): string {
	return join(agentDir, "extensions", filename);
}

export function isManagedExtensionFile(filePath: string, marker: string): boolean {
	if (!existsSync(filePath)) return false;
	try {
		const content = readFileSync(filePath, "utf8");
		return content.includes(marker);
	} catch {
		return false;
	}
}

export function removeManagedExtensionFile(filePath: string, marker: string): boolean {
	if (!existsSync(filePath) || !isManagedExtensionFile(filePath, marker)) return false;
	rmSync(filePath, { force: true });
	return true;
}

// ============================================================================
// Re-exports
// ============================================================================

export { type SymlinkOptions, type SymlinkResult };
