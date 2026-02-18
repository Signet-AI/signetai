/**
 * @signet/connector-openclaw
 *
 * Signet connector for OpenClaw (and its earlier names: clawdbot, moltbot).
 *
 * Unlike Claude Code and OpenCode, OpenClaw reads ~/.agents/AGENTS.md
 * directly — so no generated output file is needed. Instead, this
 * connector patches the JSON config to:
 *   1. Point `agents.defaults.workspace` at ~/.agents
 *   2. Enable the `signet-memory` internal hook entry
 *
 * It also installs hook handler files that OpenClaw loads for
 * /remember, /recall, and /context commands.
 *
 * @example
 * ```typescript
 * import { OpenClawConnector } from '@signet/connector-openclaw';
 *
 * const connector = new OpenClawConnector();
 * await connector.install('~/.agents');
 * ```
 */

import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
} from "@signet/connector-base";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Deep merge helper
// ============================================================================

type JsonObject = Record<string, unknown>;

/**
 * Recursively merge `source` into `target`. Arrays are replaced (not
 * concatenated); objects are merged. Mutates and returns `target`.
 */
function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
	for (const key of Object.keys(source)) {
		const srcVal = source[key];
		const tgtVal = target[key];

		if (
			srcVal !== null &&
			typeof srcVal === "object" &&
			!Array.isArray(srcVal) &&
			tgtVal !== null &&
			typeof tgtVal === "object" &&
			!Array.isArray(tgtVal)
		) {
			deepMerge(tgtVal as JsonObject, srcVal as JsonObject);
		} else {
			target[key] = srcVal;
		}
	}
	return target;
}

// ============================================================================
// OpenClaw Connector
// ============================================================================

/**
 * Connector for OpenClaw (and its historical names: clawdbot, moltbot).
 *
 * Idempotent — safe to run multiple times.
 */
export class OpenClawConnector extends BaseConnector {
	readonly name = "OpenClaw";
	readonly harnessId = "openclaw";

	/** All known config file locations, checked in order. */
	private readonly configPaths = [
		join(homedir(), ".openclaw", "openclaw.json"),
		join(homedir(), ".clawdbot", "clawdbot.json"),
		join(homedir(), ".moltbot", "moltbot.json"),
	];

	/**
	 * Install the connector.
	 *
	 * - Patches all found OpenClaw config files
	 * - Installs hook handler files under `<basePath>/hooks/agent-memory/`
	 */
	async install(basePath: string): Promise<InstallResult> {
		const expandedBasePath = this.expandPath(basePath);
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];

		const patched = await this.configureAllConfigs(expandedBasePath);
		configsPatched.push(...patched);

		const hookFiles = this.installHookFiles(expandedBasePath);
		filesWritten.push(...hookFiles);

		return {
			success: true,
			message: "OpenClaw integration installed successfully",
			filesWritten,
			configsPatched,
		};
	}

	/**
	 * Uninstall the connector.
	 *
	 * Sets `signet-memory.enabled = false` in all found configs and removes
	 * the hook handler files.
	 */
	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		for (const configPath of this.configPaths) {
			if (!existsSync(configPath)) continue;
			try {
				const raw = readFileSync(configPath, "utf-8");
				const config = JSON.parse(raw) as JsonObject;
				const indent = this.detectIndent(raw);

				deepMerge(config, {
					hooks: {
						internal: {
							entries: {
								"signet-memory": { enabled: false },
							},
						},
					},
				});

				writeFileSync(configPath, JSON.stringify(config, null, indent));
				configsPatched.push(configPath);
			} catch {
				// skip
			}
		}

		// Remove hook handler files from the first valid base path
		const basePath = join(homedir(), ".agents");
		const hookDir = join(basePath, "hooks", "agent-memory");
		for (const file of ["HOOK.md", "handler.js", "package.json"]) {
			const filePath = join(hookDir, file);
			if (existsSync(filePath)) {
				rmSync(filePath);
				filesRemoved.push(filePath);
			}
		}

		return { filesRemoved, configsPatched };
	}

	/**
	 * Check whether any OpenClaw config has signet-memory enabled.
	 */
	isInstalled(): boolean {
		for (const configPath of this.configPaths) {
			if (!existsSync(configPath)) continue;
			try {
				const config = JSON.parse(readFileSync(configPath, "utf-8"));
				if (
					config?.hooks?.internal?.entries?.["signet-memory"]?.enabled === true
				) {
					return true;
				}
			} catch {
				// malformed JSON — skip
			}
		}
		return false;
	}

	/**
	 * Get the primary config path (first existing config, or default).
	 */
	getConfigPath(): string {
		for (const configPath of this.configPaths) {
			if (existsSync(configPath)) {
				return configPath;
			}
		}
		// Default to openclaw.json if none exist
		return this.configPaths[0];
	}

	// ==========================================================================
	// Private helpers
	// ==========================================================================

	/**
	 * Find all present config files and patch each one.
	 * Returns the list of configs that were successfully patched.
	 */
	private async configureAllConfigs(basePath: string): Promise<string[]> {
		const patched: string[] = [];
		for (const configPath of this.configPaths) {
			if (!existsSync(configPath)) continue;
			try {
				this.patchConfig(configPath, basePath);
				patched.push(configPath);
			} catch (e) {
				console.warn(
					`[signet/openclaw] Could not patch ${configPath}: ${(e as Error).message}`,
				);
			}
		}
		return patched;
	}

	/**
	 * Idempotent JSON patch — deep-merges workspace pointer and
	 * signet-memory hook entry into the config file.
	 */
	private patchConfig(configPath: string, basePath: string): void {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as JsonObject;
		const indent = this.detectIndent(raw);

		deepMerge(config, {
			agents: {
				defaults: {
					workspace: basePath,
				},
			},
			hooks: {
				internal: {
					entries: {
						"signet-memory": {
							enabled: true,
						},
					},
				},
			},
		});

		writeFileSync(configPath, JSON.stringify(config, null, indent));
	}

	/**
	 * Create the hook handler files that OpenClaw loads for
	 * /remember, /recall, and /context commands.
	 *
	 * This is the canonical implementation; cli.ts delegates here.
	 */
	installHookFiles(basePath: string): string[] {
		const memoryScript = join(basePath, "memory", "scripts", "memory.py");
		const hookDir = join(basePath, "hooks", "agent-memory");
		mkdirSync(hookDir, { recursive: true });

		const hookMd = `---
name: agent-memory
description: "Signet memory integration"
---

# Agent Memory Hook (Signet)

- \`/context\` - Load memory context
- \`/remember <content>\` - Save a memory
- \`/recall <query>\` - Search memories
`;

		const handlerJs = `import { spawn } from "node:child_process";

const MEMORY_SCRIPT = ${JSON.stringify(memoryScript)};

async function runMemoryScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [MEMORY_SCRIPT, ...args], { timeout: 5000 });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || \`exit code \${code}\`));
    });
    proc.on("error", reject);
  });
}

const handler = async (event) => {
  if (event.type !== "command") return;
  const args = event.context?.args || "";

  switch (event.action) {
    case "remember":
      if (!args.trim()) { event.messages.push("🧠 Usage: /remember <content>"); return; }
      try {
        const result = await runMemoryScript([
          "save", "--mode", "explicit",
          "--who", "openclaw",
          "--content", args.trim(),
        ]);
        event.messages.push(\`🧠 \${result}\`);
      } catch (e) { event.messages.push(\`🧠 Error: \${e.message}\`); }
      break;
    case "recall":
      if (!args.trim()) { event.messages.push("🧠 Usage: /recall <query>"); return; }
      try {
        const result = await runMemoryScript(["query", args.trim(), "--limit", "10"]);
        event.messages.push(result ? \`🧠 Results:\\n\\n\${result}\` : "🧠 No memories found.");
      } catch (e) { event.messages.push(\`🧠 Error: \${e.message}\`); }
      break;
    case "context":
      try {
        const result = await runMemoryScript(["load", "--mode", "session-start"]);
        event.messages.push(result ? \`🧠 **Context**\\n\\n\${result}\` : "🧠 No context.");
      } catch (e) { event.messages.push(\`🧠 Error: \${e.message}\`); }
      break;
  }
};

export default handler;
`;

		const hookMdPath = join(hookDir, "HOOK.md");
		const handlerJsPath = join(hookDir, "handler.js");
		const packageJsonPath = join(hookDir, "package.json");

		writeFileSync(hookMdPath, hookMd);
		writeFileSync(handlerJsPath, handlerJs);
		writeFileSync(
			packageJsonPath,
			JSON.stringify(
				{ name: "agent-memory", version: "1.0.0", type: "module" },
				null,
				2,
			),
		);

		return [hookMdPath, handlerJsPath, packageJsonPath];
	}

	/** Detect the indentation style used in a JSON string. */
	private detectIndent(content: string): number {
		if (content.includes('    "')) return 4;
		return 2;
	}

	/** Expand `~` to the home directory. */
	private expandPath(path: string): string {
		if (path.startsWith("~")) {
			return join(homedir(), path.slice(1));
		}
		return path;
	}
}

// ============================================================================
// Factory + exports
// ============================================================================

/** Create an OpenClaw connector instance. */
export function createConnector(): OpenClawConnector {
	return new OpenClawConnector();
}

export default OpenClawConnector;
