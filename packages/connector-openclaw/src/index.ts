/**
 * @signet/connector-openclaw
 *
 * Signet connector for OpenClaw (and its earlier names: clawdbot, moltbot).
 *
 * Unlike Claude Code and OpenCode, OpenClaw reads ~/.agents/AGENTS.md
 * directly — so no generated output file is needed. Instead, this
 * connector can patch OpenClaw config to:
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
import { delimiter, join } from "node:path";
import { runInNewContext } from "node:vm";

// ============================================================================
// Deep merge helper
// ============================================================================

type JsonObject = Record<string, unknown>;

interface OpenClawConfigShape {
	hooks?: {
		internal?: {
			entries?: Record<string, { enabled?: boolean }>;
		};
	};
}

export interface OpenClawInstallOptions {
	configureWorkspace?: boolean;
	configureHooks?: boolean;
}

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

function stripJsonComments(source: string): string {
	let result = "";
	let inString = false;
	let quote = '"';
	let escaped = false;
	let inSingleLineComment = false;
	let inMultiLineComment = false;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (inSingleLineComment) {
			if (ch === "\n") {
				inSingleLineComment = false;
				result += ch;
			}
			continue;
		}

		if (inMultiLineComment) {
			if (ch === "*" && next === "/") {
				inMultiLineComment = false;
				i++;
			}
			continue;
		}

		if (inString) {
			result += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				inString = false;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			result += ch;
			continue;
		}

		if (ch === "/" && next === "/") {
			inSingleLineComment = true;
			i++;
			continue;
		}

		if (ch === "/" && next === "*") {
			inMultiLineComment = true;
			i++;
			continue;
		}

		result += ch;
	}

	return result;
}

function stripTrailingCommas(source: string): string {
	let result = "";
	let inString = false;
	let quote = '"';
	let escaped = false;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];

		if (inString) {
			result += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				inString = false;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			result += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;
			while (j < source.length && /\s/.test(source[j])) j++;
			if (source[j] === "}" || source[j] === "]") {
				continue;
			}
		}

		result += ch;
	}

	return result;
}

function parseJsonOrJson5(raw: string): JsonObject {
	const content = raw.replace(/^\uFEFF/, "");

	try {
		const parsed = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Top-level config must be an object");
		}
		return parsed as JsonObject;
	} catch {
		// Fallback to JSON5-like parsing.
	}

	const withoutComments = stripJsonComments(content);
	const withoutTrailingCommas = stripTrailingCommas(withoutComments);

	try {
		const parsed = JSON.parse(withoutTrailingCommas);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Top-level config must be an object");
		}
		return parsed as JsonObject;
	} catch {
		// Fall through to the isolated expression parser.
	}

	const evaluated = runInNewContext(`(${withoutComments})`, {}, { timeout: 250 });
	if (!evaluated || typeof evaluated !== "object" || Array.isArray(evaluated)) {
		throw new Error("Top-level config must be an object");
	}

	return evaluated as JsonObject;
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

	/**
	 * Install the connector.
	 *
	 * - Patches OpenClaw hook entries by default
	 * - Patches OpenClaw workspace only when explicitly requested
	 * - Installs hook handler files under `<basePath>/hooks/agent-memory/`
	 */
	async install(
		basePath: string,
		options: OpenClawInstallOptions = {},
	): Promise<InstallResult> {
		const expandedBasePath = this.expandPath(basePath);
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];

		const configureHooks = options.configureHooks ?? true;
		const configureWorkspace = options.configureWorkspace ?? true;

		const patch: JsonObject = {};
		if (configureWorkspace) {
			deepMerge(patch, {
				agents: { defaults: { workspace: expandedBasePath } },
			});
		}
		if (configureHooks) {
			deepMerge(patch, {
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
		}

		if (Object.keys(patch).length > 0) {
			const patchResult = this.patchAllConfigs(patch);
			configsPatched.push(...patchResult.patched);
			warnings.push(...patchResult.warnings);
		}

		const hookFiles = this.installHookFiles(expandedBasePath);
		filesWritten.push(...hookFiles);

		return {
			success: true,
			message: "OpenClaw integration installed successfully",
			filesWritten,
			configsPatched,
			...(warnings.length > 0 ? { warnings } : {}),
		};
	}

	/**
	 * Patch OpenClaw configs to set workspace only.
	 */
	async configureWorkspace(basePath: string): Promise<string[]> {
		const expandedBasePath = this.expandPath(basePath);
		const result = this.patchAllConfigs({
			agents: {
				defaults: {
					workspace: expandedBasePath,
				},
			},
		});
		return result.patched;
	}

	/**
	 * Return all existing OpenClaw config paths discovered on this machine.
	 */
	getDiscoveredConfigPaths(): string[] {
		return this.getConfigCandidates().filter((p) => existsSync(p));
	}

	/**
	 * Uninstall the connector.
	 *
	 * Sets `signet-memory.enabled = false` in all found configs and removes
	 * the hook handler files.
	 */
	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const patchResult = this.patchAllConfigs({
			hooks: {
				internal: {
					entries: {
						"signet-memory": { enabled: false },
					},
				},
			},
		});
		const configsPatched = patchResult.patched;

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
		for (const configPath of this.getDiscoveredConfigPaths()) {
			try {
				const config = parseJsonOrJson5(
					readFileSync(configPath, "utf-8"),
				) as OpenClawConfigShape;
				if (config.hooks?.internal?.entries?.["signet-memory"]?.enabled === true) {
					return true;
				}
			} catch {
				// malformed config — skip
			}
		}
		return false;
	}

	/**
	 * Get the primary config path (first existing config, or default).
	 */
	getConfigPath(): string {
		const candidates = this.getConfigCandidates();
		for (const configPath of candidates) {
			if (existsSync(configPath)) {
				return configPath;
			}
		}
		// Default to openclaw.json if none exist
		return candidates[0];
	}

	// ==========================================================================
	// Private helpers
	// ==========================================================================

	private getConfigCandidates(): string[] {
		const seen = new Set<string>();
		const candidates: string[] = [];

		const push = (rawPath: string | undefined) => {
			if (!rawPath) return;
			const expanded = this.expandPath(rawPath.trim());
			if (!expanded || seen.has(expanded)) return;
			seen.add(expanded);
			candidates.push(expanded);
		};

		const envPath = process.env.OPENCLAW_CONFIG_PATH;
		if (envPath) {
			for (const pathEntry of envPath.split(delimiter)) {
				push(pathEntry);
			}
		}

		const home = homedir();
		const xdgConfigHome = process.env.XDG_CONFIG_HOME
			? this.expandPath(process.env.XDG_CONFIG_HOME)
			: join(home, ".config");
		const xdgStateHome = process.env.XDG_STATE_HOME
			? this.expandPath(process.env.XDG_STATE_HOME)
			: join(home, ".local", "state");

		push(
			process.env.OPENCLAW_HOME
				? join(this.expandPath(process.env.OPENCLAW_HOME), "openclaw.json")
				: undefined,
		);
		push(
			process.env.CLAWDBOT_HOME
				? join(this.expandPath(process.env.CLAWDBOT_HOME), "clawdbot.json")
				: undefined,
		);
		push(
			process.env.MOLTBOT_HOME
				? join(this.expandPath(process.env.MOLTBOT_HOME), "moltbot.json")
				: undefined,
		);
		push(
			process.env.OPENCLAW_STATE_HOME
				? join(this.expandPath(process.env.OPENCLAW_STATE_HOME), "openclaw.json")
				: undefined,
		);

		push(join(home, ".openclaw", "openclaw.json"));
		push(join(home, ".clawdbot", "clawdbot.json"));
		push(join(home, ".moltbot", "moltbot.json"));

		push(join(xdgConfigHome, "openclaw", "openclaw.json"));
		push(join(xdgConfigHome, "clawdbot", "clawdbot.json"));
		push(join(xdgConfigHome, "moltbot", "moltbot.json"));

		push(join(xdgStateHome, "openclaw", "openclaw.json"));
		push(join(xdgStateHome, "clawdbot", "clawdbot.json"));
		push(join(xdgStateHome, "moltbot", "moltbot.json"));

		return candidates;
	}

	private patchAllConfigs(patch: JsonObject): {
		patched: string[];
		warnings: string[];
	} {
		const patched: string[] = [];
		const warnings: string[] = [];

		for (const configPath of this.getDiscoveredConfigPaths()) {
			try {
				this.patchConfig(configPath, patch);
				patched.push(configPath);
			} catch (e) {
				const message = (e as Error).message || "unknown parse/write error";
				const warning = `[signet/openclaw] Skipped patch for ${configPath}: ${message}`;
				warnings.push(warning);
				console.warn(warning);
			}
		}

		return { patched, warnings };
	}

	private patchConfig(configPath: string, patch: JsonObject): void {
		const raw = readFileSync(configPath, "utf-8");
		let config: JsonObject;
		try {
			config = parseJsonOrJson5(raw);
		} catch (e) {
			throw new Error(
				`could not parse JSON/JSON5 config (${(e as Error).message})`,
			);
		}

		const indent = this.detectIndent(raw);
		deepMerge(config, patch);
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
