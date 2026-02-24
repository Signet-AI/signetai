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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildSignetBlock,
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
 * - buildSignetBlock() - generate Signet system block for injected configs
 * - stripSignetBlock() - remove existing Signet blocks before re-injection
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
	 * Build the Signet system block for injection into harness config files.
	 *
	 * This block provides agents with essential Signet information:
	 * - Key files in ~/.agents/
	 * - Dashboard URL
	 * - Memory commands (/remember, /recall)
	 * - Secrets commands
	 */
	protected buildSignetBlock(): string {
		return buildSignetBlock();
	}

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
	 * Symlink skills from source to target directory.
	 *
	 * Each subdirectory in sourceDir becomes a symlink in targetDir.
	 * Existing symlinks are replaced; real directories are skipped.
	 */
	protected symlinkSkills(
		sourceDir: string,
		targetDir: string,
		options?: SymlinkOptions,
	): SymlinkResult {
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
		return `# Auto-generated from ${sourcePath}
# Source: ${sourcePath}
# Generated: ${new Date().toISOString()}
# DO NOT EDIT - changes will be overwritten
# Edit the source files in ~/.agents/ instead

`;
	}

	/**
	 * Read and compose additional identity files (SOUL.md, IDENTITY.md,
	 * USER.md, MEMORY.md) into a single string with section headers.
	 *
	 * @param basePath - Path to ~/.agents/ or equivalent identity directory
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
// Re-exports
// ============================================================================

export { type SymlinkOptions, type SymlinkResult };
