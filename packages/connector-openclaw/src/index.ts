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
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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
	plugins?: {
		slots?: {
			memory?: string;
		};
		entries?: Record<
			string,
			{ enabled?: boolean; config?: Record<string, unknown> }
		>;
	};
	agents?: {
		defaults?: {
			workspace?: string;
			memorySearch?: {
				enabled?: boolean;
			};
		};
	};
	signet?: Record<string, unknown>;
}

export interface OpenClawInstallOptions {
	configureWorkspace?: boolean;
	configureHooks?: boolean;
	runtimePath?: "plugin" | "legacy";
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

	const evaluated = runInNewContext(
		`(${withoutComments})`,
		{},
		{ timeout: 250 },
	);
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
		const runtimePath = options.runtimePath ?? "legacy";

		const patch: JsonObject = {};
		if (configureWorkspace) {
			this.validateWorkspacePath(basePath);
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

		if (runtimePath === "plugin") {
			deepMerge(patch, {
				plugins: {
					slots: {
						memory: "signet-memory-openclaw",
					},
					entries: {
						"signet-memory-openclaw": {
							enabled: true,
							config: {
								daemonUrl: "http://localhost:3850",
							},
						},
					},
				},
				agents: {
					defaults: {
						memorySearch: {
							enabled: false,
						},
					},
				},
			});
		}

		if (Object.keys(patch).length > 0) {
			if (runtimePath === "plugin") {
				const pluginResult = this.patchAllConfigsWithPlugin(patch);
				configsPatched.push(...pluginResult.patched);
				warnings.push(...pluginResult.warnings);
			} else {
				const patchResult = this.patchAllConfigs(patch);
				configsPatched.push(...patchResult.patched);
				warnings.push(...patchResult.warnings);
			}
		}

		const hookFiles = this.installHookFiles(expandedBasePath);
		filesWritten.push(...hookFiles);

		return {
			success: true,
			message: `OpenClaw integration installed (${runtimePath} path)`,
			filesWritten,
			configsPatched,
			...(warnings.length > 0 ? { warnings } : {}),
		};
	}

	/**
	 * Patch OpenClaw configs to set workspace only.
	 */
	async configureWorkspace(basePath: string): Promise<string[]> {
		this.validateWorkspacePath(basePath);
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
	 * Return normalized workspace paths declared in discovered OpenClaw configs.
	 *
	 * Paths are expanded (`~` -> home) and de-duplicated.
	 */
	getDiscoveredWorkspacePaths(): string[] {
		const workspaces: string[] = [];
		const seen = new Set<string>();

		for (const configPath of this.getDiscoveredConfigPaths()) {
			try {
				const config = parseJsonOrJson5(
					readFileSync(configPath, "utf-8"),
				) as OpenClawConfigShape;
				const rawWorkspace = config.agents?.defaults?.workspace;
				if (typeof rawWorkspace !== "string") {
					continue;
				}

				const trimmed = rawWorkspace.trim();
				if (trimmed.length === 0) {
					continue;
				}

				const expanded = resolve(this.expandPath(trimmed));
				if (seen.has(expanded)) {
					continue;
				}

				seen.add(expanded);
				workspaces.push(expanded);
			} catch {
				// Malformed config; skip workspace extraction.
			}
		}

		return workspaces;
	}

	/**
	 * Uninstall the connector.
	 *
	 * Disables both legacy hooks and plugin entries, removes hook handler files.
	 */
	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];

		// Disable legacy hooks
		const hookResult = this.patchAllConfigs({
			hooks: {
				internal: {
					entries: {
						"signet-memory": { enabled: false },
					},
				},
			},
		});

		// Disable plugin entries (both old and new names), release slot
		const pluginResult = this.patchAllConfigs({
			plugins: {
				slots: {
					memory: "memory-core",
				},
				entries: {
					"signet-memory": { enabled: false },
					"signet-memory-openclaw": { enabled: false },
				},
			},
			agents: {
				defaults: {
					memorySearch: {
						enabled: true,
					},
				},
			},
		});

		const configsPatched = [
			...new Set([...hookResult.patched, ...pluginResult.patched]),
		];

		// Remove hook handler files from the first valid base path
		const basePath = join(this.getHomeDir(), ".agents");
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
	 * Check whether any OpenClaw config has signet enabled
	 * (via legacy hooks or plugin entry).
	 */
	isInstalled(): boolean {
		for (const configPath of this.getDiscoveredConfigPaths()) {
			try {
				const config = parseJsonOrJson5(
					readFileSync(configPath, "utf-8"),
				) as OpenClawConfigShape;
				// Legacy hook system
				if (
					config.hooks?.internal?.entries?.["signet-memory"]?.enabled === true
				) {
					return true;
				}
				// Plugin system (new name)
				if (
					config.plugins?.entries?.["signet-memory-openclaw"]?.enabled === true
				) {
					return true;
				}
				// Plugin system (old name, pre-migration)
				if (
					config.plugins?.entries?.["signet-memory"]?.enabled === true
				) {
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

	/**
	 * Reject workspace paths that point into temp directories.
	 * Prevents accidental persistence of test/ephemeral paths
	 * in production OpenClaw configs.
	 */
	private validateWorkspacePath(p: string): void {
		const resolved = resolve(this.expandPath(p));
		const tmp = tmpdir();
		if (resolved.startsWith(tmp) || resolved.startsWith("/tmp/")) {
			throw new Error(
				`Refusing to set workspace to temp directory: ${resolved}`,
			);
		}
	}

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

		const home = this.getHomeDir();
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
				? join(
						this.expandPath(process.env.OPENCLAW_STATE_HOME),
						"openclaw.json",
					)
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

	/**
	 * Patch configs with plugin entry using the object format:
	 * plugins.entries["signet-memory-openclaw"] = { enabled, config }
	 *
	 * Migrates:
	 * - Legacy array-style plugins (["signet-memory"] -> { entries: {...} })
	 * - Top-level `signet: { daemonUrl }` key
	 * - Old plugin name "signet-memory" -> "signet-memory-openclaw"
	 */
	private patchAllConfigsWithPlugin(patch: JsonObject): {
		patched: string[];
		warnings: string[];
	} {
		const patched: string[] = [];
		const warnings: string[] = [];
		const pluginName = "signet-memory-openclaw";

		for (const configPath of this.getDiscoveredConfigPaths()) {
			try {
				const raw = readFileSync(configPath, "utf-8");
				const config = parseJsonOrJson5(raw);
				const indent = this.detectIndent(raw);

				// Migrate legacy array-style plugins to object format
				if (Array.isArray(config.plugins)) {
					const oldArray = config.plugins as string[];
					const entries: JsonObject = {};
					for (const name of oldArray) {
						entries[name] = { enabled: true };
					}
					config.plugins = { entries };
				}

				// Migrate old plugin name "signet-memory" -> "signet-memory-openclaw"
				{
					const pluginsObj = (config.plugins ?? {}) as JsonObject;
					const entriesObj = (pluginsObj.entries ?? {}) as JsonObject;
					const OLD_NAME = "signet-memory";
					if (OLD_NAME in entriesObj && !(pluginName in entriesObj)) {
						entriesObj[pluginName] = entriesObj[OLD_NAME];
						delete entriesObj[OLD_NAME];
						pluginsObj.entries = entriesObj;
						config.plugins = pluginsObj;
					} else if (OLD_NAME in entriesObj && pluginName in entriesObj) {
						// Both exist — drop the old one
						delete entriesObj[OLD_NAME];
						pluginsObj.entries = entriesObj;
						config.plugins = pluginsObj;
					}
				}

				// Migrate top-level `signet` key into plugin config
				if (config.signet && typeof config.signet === "object") {
					const legacySignet = config.signet as JsonObject;
					const pluginsObj = (config.plugins ?? { entries: {} }) as JsonObject;
					const entriesObj = (pluginsObj.entries ?? {}) as JsonObject;
					const pluginEntry = (entriesObj[pluginName] ?? { enabled: true }) as JsonObject;
					const pluginConfig = (pluginEntry.config ?? {}) as JsonObject;

					if (legacySignet.daemonUrl) {
						pluginConfig.daemonUrl = legacySignet.daemonUrl;
					}
					pluginEntry.config = pluginConfig;
					pluginEntry.enabled = true;
					entriesObj[pluginName] = pluginEntry;
					pluginsObj.entries = entriesObj;
					config.plugins = pluginsObj;
					delete config.signet;
				}

				deepMerge(config, patch);
				writeFileSync(
					configPath,
					JSON.stringify(config, null, indent),
				);
				patched.push(configPath);
			} catch (e) {
				const message =
					(e as Error).message || "unknown parse/write error";
				const warning =
					`[signet/openclaw] Skipped patch for ${configPath}: ${message}`;
				warnings.push(warning);
				console.warn(warning);
			}
		}

		return { patched, warnings };
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

		const handlerJs = `const DAEMON_URL = process.env.SIGNET_DAEMON_URL || "http://localhost:3850";

async function fetchDaemon(path, body) {
  const res = await fetch(\`\${DAEMON_URL}\${path}\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signet-runtime-path": "legacy",
    },
    body: JSON.stringify({ ...body, runtimePath: "legacy" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(\`daemon \${res.status}\`);
  return res.json();
}

const handler = async (event) => {
  // When the plugin runtime path is active, legacy hooks are disabled
  // to prevent duplicate capture/recall. Set SIGNET_RUNTIME_PATH=plugin
  // in your environment to use the plugin path exclusively.
  if (process.env.SIGNET_RUNTIME_PATH === "plugin") return;

  if (event.type !== "command") return;
  const args = event.context?.args || "";

  switch (event.action) {
    case "remember":
      if (!args.trim()) { event.messages.push("Usage: /remember <content>"); return; }
      try {
        await fetchDaemon("/api/hooks/remember", {
          harness: "openclaw", who: "openclaw", content: args.trim(),
        });
        event.messages.push(\`saved: \${args.trim().slice(0, 50)}...\`);
      } catch (e) { event.messages.push(\`Error: \${e.message}\`); }
      break;
    case "recall":
      if (!args.trim()) { event.messages.push("Usage: /recall <query>"); return; }
      try {
        const data = await fetchDaemon("/api/hooks/recall", {
          harness: "openclaw", query: args.trim(),
        });
        if (data.results?.length) {
          event.messages.push(data.results.map(r => \`- \${r.content}\`).join("\\n"));
        } else {
          event.messages.push("No memories found.");
        }
      } catch (e) { event.messages.push(\`Error: \${e.message}\`); }
      break;
    case "context":
      try {
        const data = await fetchDaemon("/api/hooks/session-start", {
          harness: "openclaw",
        });
        event.messages.push(data.inject || "no context");
      } catch (e) { event.messages.push(\`Error: \${e.message}\`); }
      break;
  }
};

export default handler;
`;

		const hookMdPath = join(hookDir, "HOOK.md");
		const handlerJsPath = join(hookDir, "handler.js");
		const packageJsonPath = join(hookDir, "package.json");

		const migrationMd = `# Signet OpenClaw Runtime Path Migration

## Plugin vs Legacy Hooks

Signet supports two runtime paths for OpenClaw integration:

1. **Plugin path** (preferred): \`signet-memory-openclaw\` runtime
   plugin handles all memory operations directly.
2. **Legacy hook path** (compatibility): These handler.js files process
   /remember, /recall, and /context commands via daemon hook endpoints.

## Switching to Plugin Path

Set the environment variable before starting OpenClaw:

    SIGNET_RUNTIME_PATH=plugin

This disables legacy hooks so only the plugin handles memory operations.
Both paths cannot be active simultaneously per session — the daemon
enforces this via session claiming.

## When to Use Legacy Path

Keep legacy hooks active (the default) if:

- \`signet-memory-openclaw\` is not configured as an OpenClaw plugin
- You need command-based /remember and /recall without plugin support

## Safety

The daemon prevents duplicate capture/recall when both paths are
configured by rejecting session claims from the second path (HTTP 409).
`;

		const migrationMdPath = join(hookDir, "MIGRATION.md");

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
		writeFileSync(migrationMdPath, migrationMd);

		return [hookMdPath, handlerJsPath, packageJsonPath, migrationMdPath];
	}

	/** Detect the indentation style used in a JSON string. */
	private detectIndent(content: string): number {
		if (content.includes('    "')) return 4;
		return 2;
	}

	private getHomeDir(): string {
		const home = process.env.HOME;
		if (typeof home === "string" && home.trim().length > 0) {
			return home.trim();
		}

		return homedir();
	}

	/** Expand `~` to the home directory. */
	private expandPath(path: string): string {
		if (path === "~") {
			return this.getHomeDir();
		}

		if (path.startsWith("~/")) {
			return join(this.getHomeDir(), path.slice(2));
		}

		if (path.startsWith("~")) {
			return join(this.getHomeDir(), path.slice(1));
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
