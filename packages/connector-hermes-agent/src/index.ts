import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
import { expandHome, resolveHermesHomePath, resolveHermesRepoPath, resolveHermesRepoPluginPath } from "@signet/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Plugin file management
// ---------------------------------------------------------------------------

/** Path to the bundled hermes-plugin directory shipped alongside this connector. */
function getPluginSourceDir(): string {
	// In the built package, hermes-plugin/ is sibling to dist/
	const fromDist = join(__dirname, "..", "hermes-plugin");
	if (existsSync(fromDist)) return fromDist;
	// In development, hermes-plugin/ is at package root
	const fromSrc = join(__dirname, "..", "..", "hermes-plugin");
	if (existsSync(fromSrc)) return fromSrc;
	throw new Error("Cannot find hermes-plugin directory in connector package");
}

function getPluginTargetDir(hermesRepo: string): string {
	return join(hermesRepo, "plugins", "memory", "signet");
}

/** Copy the Signet memory plugin into the Hermes plugins directory. */
function installPlugin(hermesRepo: string): string[] {
	const sourceDir = getPluginSourceDir();
	const targetDir = getPluginTargetDir(hermesRepo);

	mkdirSync(targetDir, { recursive: true });

	const files = ["__init__.py", "client.py", "plugin.yaml", "README.md"];
	const written: string[] = [];

	for (const file of files) {
		const src = join(sourceDir, file);
		const dst = join(targetDir, file);
		if (existsSync(src)) {
			writeFileSync(dst, readFileSync(src));
			written.push(dst);
		}
	}

	return written;
}

/** Remove the Signet memory plugin from the Hermes plugins directory. */
function uninstallPlugin(hermesRepo: string): string[] {
	const targetDir = getPluginTargetDir(hermesRepo);
	const removed: string[] = [];

	if (existsSync(targetDir)) {
		rmSync(targetDir, { recursive: true, force: true });
		removed.push(targetDir);
	}

	return removed;
}

// ---------------------------------------------------------------------------
// Config patching
// ---------------------------------------------------------------------------

/** Read the Hermes CLI config.yaml if it exists. */
function readConfigYaml(hermesHome: string): string | null {
	const configPath = join(hermesHome, "cli-config.yaml");
	if (!existsSync(configPath)) return null;
	try {
		return readFileSync(configPath, "utf-8");
	} catch {
		return null;
	}
}

/** Check if memory.provider is already set to "signet" in config. */
function isProviderConfigured(hermesHome: string): boolean {
	const content = readConfigYaml(hermesHome);
	if (!content) return false;
	// Simple YAML check — look for "provider: signet" under memory section
	return (
		/memory:\s*\n\s+provider:\s*["']?signet["']?/m.test(content) ||
		/^memory\.provider:\s*["']?signet["']?/m.test(content)
	);
}

function sanitizedEnv(name: string): string {
	return (process.env[name]?.trim() || "").replace(/[\r\n]+/g, "");
}

type AgentReadPolicy = "isolated" | "shared" | "group";

function configuredAgentReadPolicy(warnings: string[]): AgentReadPolicy {
	const raw = sanitizedEnv("SIGNET_AGENT_READ_POLICY") || sanitizedEnv("SIGNET_AGENT_MEMORY_POLICY");
	if (!raw) return "shared";
	if (raw === "isolated" || raw === "shared" || raw === "group") return raw;
	warnings.push(`Ignoring unsupported SIGNET_AGENT_READ_POLICY '${raw}'. Expected one of: isolated, shared, group.`);
	return "shared";
}

async function ensureNamedAgentRegistered(daemonUrl: string, agentId: string, warnings: string[]): Promise<void> {
	if (!agentId || agentId === "default" || agentId === "hermes-agent") return;
	if (process.env.SIGNET_SKIP_AGENT_REGISTER === "1") return;

	const baseUrl = daemonUrl.replace(/\/+$/, "");
	const token = sanitizedEnv("SIGNET_TOKEN");
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		const getResp = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`, {
			headers,
			signal: AbortSignal.timeout(1_000),
		});
		if (getResp.ok) return;
		if (getResp.status !== 404) {
			const body = await getResp.text();
			warnings.push(
				`Could not check Signet agent '${agentId}' before registration: HTTP ${getResp.status} ${body.slice(0, 200)}`,
			);
			return;
		}
	} catch {
		// Daemon may be offline; the POST below will produce the user-facing warning.
	}

	const readPolicy = configuredAgentReadPolicy(warnings);
	const policyGroup = readPolicy === "group" ? sanitizedEnv("SIGNET_AGENT_POLICY_GROUP") || null : null;
	if (readPolicy === "group" && !policyGroup) {
		warnings.push(
			`SIGNET_AGENT_READ_POLICY=group requires SIGNET_AGENT_POLICY_GROUP. Registering '${agentId}' with isolated memory instead.`,
		);
	}
	const effectiveReadPolicy: AgentReadPolicy = readPolicy === "group" && !policyGroup ? "isolated" : readPolicy;
	const policyHint =
		effectiveReadPolicy === "shared"
			? `Run: signet agent create ${agentId} --memory shared, or use --memory isolated for private memory.`
			: `Run: signet agent create ${agentId} --memory ${effectiveReadPolicy}.`;

	try {
		const resp = await fetch(`${baseUrl}/api/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({
				name: agentId,
				read_policy: effectiveReadPolicy,
				policy_group: policyGroup,
			}),
			signal: AbortSignal.timeout(1_000),
		});
		if (!resp.ok) {
			const body = await resp.text();
			warnings.push(
				`Could not register Signet agent '${agentId}' with ${effectiveReadPolicy} memory policy: ${body.slice(0, 200)}. ${policyHint}`,
			);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		warnings.push(
			`Could not register Signet agent '${agentId}' because the daemon was unreachable. ` + `${policyHint} (${msg})`,
		);
	}
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class HermesAgentConnector extends BaseConnector {
	readonly name = "Hermes Agent";
	readonly harnessId = "hermes-agent";

	private getHermesHome(): string {
		return resolveHermesHomePath();
	}

	private getHermesRepo(): string | null {
		return resolveHermesRepoPath();
	}

	getConfigPath(): string {
		return join(this.getHermesHome(), "cli-config.yaml");
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));
		const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const hermesHome = this.getHermesHome();
		const hermesRepo = this.getHermesRepo();

		// 1. Install the Python plugin into plugins/memory/signet/
		if (hermesRepo) {
			try {
				const pluginFiles = installPlugin(hermesRepo);
				filesWritten.push(...pluginFiles);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				warnings.push(`Failed to install plugin files: ${msg}`);
			}
		} else {
			warnings.push(
				"Hermes Agent install not found. Install Hermes in ~/.hermes or set HERMES_REPO to the hermes-agent directory, " +
					"then re-run setup. Alternatively, copy the plugin manually:\n" +
					"  cp -r <signet>/packages/connector-hermes-agent/hermes-plugin/ " +
					"<hermes-agent>/plugins/memory/signet/",
			);
		}

		// 2. Write env config for the Signet daemon connection
		const envPath = join(hermesHome, ".env");
		let configuredSignetAgentId = "hermes-agent";
		const configuredDaemonUrl = (process.env.SIGNET_DAEMON_URL?.trim() || "http://localhost:3850").replace(
			/[\r\n]+/g,
			"",
		);
		try {
			let envContent = "";
			if (existsSync(envPath)) {
				envContent = readFileSync(envPath, "utf-8");
			}

			const signetVars: Record<string, string> = {};

			if (process.env.SIGNET_DAEMON_URL) {
				signetVars.SIGNET_DAEMON_URL = sanitizedEnv("SIGNET_DAEMON_URL");
			}
			// Always write SIGNET_AGENT_ID — never allow the plugin to fall back to the
			// shared "default" scope (AGENTS.md: never hardcode "default" for scoped paths).
			const signetAgentId = sanitizedEnv("SIGNET_AGENT_ID") || "hermes-agent";
			configuredSignetAgentId = signetAgentId;
			signetVars.SIGNET_AGENT_ID = signetAgentId;

			const explicitAgentWorkspace = process.env.SIGNET_AGENT_WORKSPACE?.trim();
			if (explicitAgentWorkspace) {
				signetVars.SIGNET_AGENT_WORKSPACE = expandHome(explicitAgentWorkspace).replace(/[\r\n]+/g, "");
			} else if (signetAgentId && signetAgentId !== "hermes-agent" && signetAgentId !== "default") {
				const agentWorkspace = join(expandedBasePath, "agents", signetAgentId);
				if (existsSync(agentWorkspace)) {
					signetVars.SIGNET_AGENT_WORKSPACE = agentWorkspace;
				}
			}

			// Persist auth token so Hermes can reach a non-localhost daemon.
			// Warn if absent and SIGNET_DAEMON_URL points to a remote host.
			if (process.env.SIGNET_TOKEN) {
				signetVars.SIGNET_TOKEN = sanitizedEnv("SIGNET_TOKEN");
			} else if (
				process.env.SIGNET_DAEMON_URL &&
				!process.env.SIGNET_DAEMON_URL.includes("localhost") &&
				!process.env.SIGNET_DAEMON_URL.includes("127.0.0.1")
			) {
				warnings.push(
					`SIGNET_TOKEN is not set. The Signet daemon at ${process.env.SIGNET_DAEMON_URL} may require authentication. Set SIGNET_TOKEN in your environment before starting Hermes.`,
				);
			}

			let changed = false;
			for (const [key, value] of Object.entries(signetVars)) {
				const pattern = new RegExp(`^${key}=.*$`, "m");
				if (pattern.test(envContent)) {
					envContent = envContent.replace(pattern, `${key}=${value}`);
				} else {
					envContent = `${envContent.trimEnd()}\n${key}=${value}\n`;
				}
				changed = true;
			}

			if (changed) {
				mkdirSync(hermesHome, { recursive: true });
				writeFileSync(envPath, envContent);
				configsPatched.push(envPath);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(`Failed to update .env: ${msg}`);
		}

		await ensureNamedAgentRegistered(configuredDaemonUrl, configuredSignetAgentId, warnings);

		// 3. Provide guidance on completing setup
		if (!isProviderConfigured(hermesHome)) {
			warnings.push(
				"To activate Signet as your memory provider, run:\n" +
					"  hermes memory setup\n" +
					"and select 'signet', or manually:\n" +
					"  hermes config set memory.provider signet",
			);
		}

		const message = hermesRepo
			? "Hermes Agent integration installed — Signet memory plugin deployed"
			: "Hermes Agent integration partially installed — plugin files need manual copy";

		return {
			success: true,
			message,
			filesWritten,
			configsPatched,
			warnings,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		const hermesRepo = this.getHermesRepo();
		if (hermesRepo) {
			const removed = uninstallPlugin(hermesRepo);
			filesRemoved.push(...removed);
		}

		// Clean up env vars
		const hermesHome = this.getHermesHome();
		const envPath = join(hermesHome, ".env");
		if (existsSync(envPath)) {
			try {
				let envContent = readFileSync(envPath, "utf-8");
				let changed = false;
				for (const key of ["SIGNET_DAEMON_URL", "SIGNET_AGENT_ID", "SIGNET_AGENT_WORKSPACE", "SIGNET_TOKEN"]) {
					const pattern = new RegExp(`^${key}=.*\n?`, "gm");
					if (pattern.test(envContent)) {
						envContent = envContent.replace(pattern, "");
						changed = true;
					}
				}
				if (changed) {
					writeFileSync(envPath, `${envContent.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);
					configsPatched.push(envPath);
				}
			} catch (e) {
				// Best effort — log but don't fail the uninstall
				console.warn(`[hermes-agent] Failed to clean up .env: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		return resolveHermesRepoPluginPath() !== null;
	}
}

export function createConnector(): HermesAgentConnector {
	return new HermesAgentConnector();
}

export default HermesAgentConnector;
