import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseConnector, type InstallResult, type UninstallResult } from "@signet/connector-base";
import { expandHome, resolveHermesHomePath, resolveHermesRepoPath } from "@signet/core";

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
	// In the native bundle (SIGNET_DIR), hermes-plugin/ lives inside the
	// connectors directory alongside the connector JS output.
	const signetDir = process.env.SIGNET_DIR?.trim();
	if (signetDir) {
		const fromConnectors = join(signetDir, "runtime", "connectors", "hermes-agent", "hermes-plugin");
		if (existsSync(fromConnectors)) return fromConnectors;
	}
	throw new Error("Cannot find hermes-plugin directory in connector package");
}

const PLUGIN_FILES = ["__init__.py", "client.py", "plugin.yaml", "README.md"] as const;
const INSTALL_MARKER_FILE = "signet.install.json";
const PROVIDER_BACKUP_FILE = "signet.provider.backup.json";
const REQUIRED_TOOL_NAMES = [
	"memory_search",
	"memory_store",
	"memory_get",
	"memory_list",
	"memory_modify",
	"memory_forget",
	// `session_search` shadows Hermes's built-in core tool of the same
	// name and gets dropped at registration time, so the Signet provider
	// surfaces it under the namespace instead.
	"signet_session_search",
	"recall",
	"remember",
] as const;

export interface HermesDiagnosticCheck {
	readonly id: string;
	readonly label: string;
	readonly ok: boolean;
	readonly detail: string;
	readonly fix?: string;
}

export interface HermesDoctorReport {
	readonly ok: boolean;
	readonly hermesHome: string;
	readonly hermesRepo: string | null;
	readonly configPath: string;
	readonly userPluginDir: string;
	readonly repoPluginDir: string | null;
	readonly toolNames: readonly string[];
	readonly checks: readonly HermesDiagnosticCheck[];
	readonly warnings: readonly string[];
}

interface InstallMarker {
	readonly connector: "@signet/connector-hermes-agent";
	readonly schemaVersion: 1;
	readonly connectorVersion: string;
	readonly sourceHash: string;
	readonly targetKind: "user" | "repo";
	readonly installedAt: string;
}

interface ProviderBackup {
	readonly schemaVersion: 1;
	readonly configPath: string;
	readonly providerKind: "nested" | "dotted";
	readonly previousProvider: string;
	readonly createdAt: string;
}

interface HermesProbeResult {
	readonly ok: boolean;
	readonly toolNames: readonly string[];
	readonly error: string | null;
}

function getRepoPluginTargetDir(hermesRepo: string): string {
	return join(hermesRepo, "plugins", "memory", "signet");
}

function getUserPluginTargetDir(hermesHome: string): string {
	return join(hermesHome, "plugins", "signet");
}

function getProviderBackupPath(hermesHome: string): string {
	return join(hermesHome, PROVIDER_BACKUP_FILE);
}

/** Copy the Signet memory plugin into a Hermes plugin directory. */
function installPlugin(targetDir: string, targetKind: InstallMarker["targetKind"]): string[] {
	const sourceDir = getPluginSourceDir();

	mkdirSync(targetDir, { recursive: true });

	const written: string[] = [];

	for (const file of PLUGIN_FILES) {
		const src = join(sourceDir, file);
		const dst = join(targetDir, file);
		if (existsSync(src)) {
			writeFileSync(dst, readFileSync(src));
			written.push(dst);
		}
	}
	written.push(writeInstallMarker(targetDir, targetKind));

	return written;
}

/** Remove the Signet memory plugin from the Hermes plugins directory. */
function uninstallPlugin(targetDir: string): string[] {
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

function getConfigCandidates(hermesHome: string): string[] {
	return [join(hermesHome, "config.yaml"), join(hermesHome, "cli-config.yaml")];
}

function resolveConfigPath(hermesHome: string): string {
	for (const candidate of getConfigCandidates(hermesHome)) {
		if (existsSync(candidate)) return candidate;
	}
	return join(hermesHome, "config.yaml");
}

function readConfigYaml(hermesHome: string): { path: string; content: string } | null {
	const configPath = resolveConfigPath(hermesHome);
	if (!existsSync(configPath)) return null;
	try {
		return { path: configPath, content: readFileSync(configPath, "utf-8") };
	} catch {
		return null;
	}
}

interface MemoryBlock {
	start: number;
	end: number;
	provider: number | null;
	indent: number;
}

function isBlankOrComment(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === "" || trimmed.startsWith("#");
}

function parseScalar(value: string): string {
	const stripped = value.split("#", 1)[0]?.trim() ?? "";
	if ((stripped.startsWith('"') && stripped.endsWith('"')) || (stripped.startsWith("'") && stripped.endsWith("'"))) {
		return stripped.slice(1, -1);
	}
	return stripped;
}

function leadingWhitespaceLength(line: string): number | null {
	const match = /^(\s+)/.exec(line);
	return match ? (match[1]?.length ?? null) : null;
}

function isYamlMappingEntry(value: string): boolean {
	const trimmed = value.trimStart();
	if (trimmed.startsWith("-")) return false;
	const colon = trimmed.indexOf(":");
	if (colon <= 0) return false;
	return trimmed.slice(0, colon).trim().length > 0;
}

function findMemoryBlock(lines: string[]): MemoryBlock | "missing" | null {
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^memory:\s*(?:#.*)?$/.test(lines[i] ?? "")) starts.push(i);
		if (/^memory:\s*\S/.test(lines[i] ?? "")) return null;
	}
	if (starts.length === 0) return "missing";
	if (starts.length !== 1) return null;
	const start = starts[0] ?? 0;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (!isBlankOrComment(line) && !/^\s/.test(line)) {
			end = i;
			break;
		}
	}
	let indent: number | null = null;
	for (let i = start + 1; i < end; i++) {
		const line = lines[i] ?? "";
		if (isBlankOrComment(line)) continue;
		const lineIndent = leadingWhitespaceLength(line);
		if (lineIndent === null) continue;
		indent = indent === null ? lineIndent : Math.min(indent, lineIndent);
	}
	let provider: number | null = null;
	const childIndent = indent ?? 2;
	for (let i = start + 1; i < end; i++) {
		const line = lines[i] ?? "";
		if (leadingWhitespaceLength(line) !== childIndent) continue;
		const child = line.slice(childIndent);
		if (!isYamlMappingEntry(child)) return null;
		if (/^provider:\s*/.test(child)) {
			provider = i;
			break;
		}
	}
	return { start, end, provider, indent: childIndent };
}

function providerLineIsSignet(line: string): boolean {
	const match = /^\s+provider:\s*(.*)$/.exec(line);
	return match ? parseScalar(match[1] ?? "") === "signet" : false;
}

function parseProviderLine(line: string): string | null {
	const match = /^\s+provider:\s*(.*)$/.exec(line);
	return match ? parseScalar(match[1] ?? "") : null;
}

function findDottedProvider(lines: string[]): number | null {
	for (let i = 0; i < lines.length; i++) {
		if (/^memory\.provider:\s*/.test(lines[i] ?? "")) return i;
	}
	return null;
}

function dottedProviderLineIsSignet(line: string): boolean {
	const match = /^memory\.provider:\s*(.*)$/.exec(line);
	return match ? parseScalar(match[1] ?? "") === "signet" : false;
}

function parseDottedProviderLine(line: string): string | null {
	const match = /^memory\.provider:\s*(.*)$/.exec(line);
	return match ? parseScalar(match[1] ?? "") : null;
}

function setDottedProviderLine(lines: string[], line: number, value: string): void {
	lines[line] = `memory.provider: ${value}`;
}

function writeProviderBackup(
	hermesHome: string,
	configPath: string,
	providerKind: ProviderBackup["providerKind"],
	previousProvider: string,
): string | null {
	if (previousProvider === "signet") return null;
	const backupPath = getProviderBackupPath(hermesHome);
	if (existsSync(backupPath)) return null;
	const backup: ProviderBackup = {
		schemaVersion: 1,
		configPath,
		providerKind,
		previousProvider,
		createdAt: new Date().toISOString(),
	};
	mkdirSync(dirname(backupPath), { recursive: true });
	writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`);
	return backupPath;
}

function readProviderBackup(hermesHome: string): ProviderBackup | null {
	const backupPath = getProviderBackupPath(hermesHome);
	if (!existsSync(backupPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(backupPath, "utf-8")) as Partial<ProviderBackup>;
		if (
			parsed.schemaVersion === 1 &&
			typeof parsed.configPath === "string" &&
			(parsed.providerKind === "nested" || parsed.providerKind === "dotted") &&
			typeof parsed.previousProvider === "string" &&
			typeof parsed.createdAt === "string"
		) {
			return parsed as ProviderBackup;
		}
		return null;
	} catch {
		return null;
	}
}

function removeProviderBackup(hermesHome: string): string | null {
	const backupPath = getProviderBackupPath(hermesHome);
	if (!existsSync(backupPath)) return null;
	rmSync(backupPath, { force: true });
	return backupPath;
}

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) {
		end--;
	}
	return value.slice(0, end);
}

function isProviderConfigured(hermesHome: string): boolean {
	const config = readConfigYaml(hermesHome);
	if (!config) return false;
	const lines = config.content.split(/\r?\n/);
	const dottedProvider = findDottedProvider(lines);
	if (dottedProvider !== null) return dottedProviderLineIsSignet(lines[dottedProvider] ?? "");
	const block = findMemoryBlock(lines);
	if (
		block !== null &&
		typeof block === "object" &&
		block.provider !== null &&
		block.provider !== undefined &&
		providerLineIsSignet(lines[block.provider] ?? "")
	) {
		return true;
	}
	return false;
}

function configureProvider(
	hermesHome: string,
	warnings: string[],
): { configPath: string | null; backupPath: string | null } {
	const configPath = resolveConfigPath(hermesHome);
	let content = "";
	if (existsSync(configPath)) {
		try {
			content = readFileSync(configPath, "utf-8");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(`Could not read Hermes config at ${configPath}: ${msg}`);
			return { configPath: null, backupPath: null };
		}
	}

	const lines = content ? content.replace(/\r\n/g, "\n").split("\n") : [];
	const block = findMemoryBlock(lines);
	const dottedProvider = findDottedProvider(lines);
	let backupPath: string | null = null;
	if (dottedProvider !== null) {
		let changed = false;
		const dottedWasSignet = dottedProviderLineIsSignet(lines[dottedProvider] ?? "");
		if (!dottedWasSignet) {
			backupPath = writeProviderBackup(
				hermesHome,
				configPath,
				"dotted",
				parseDottedProviderLine(lines[dottedProvider] ?? "") ?? "",
			);
			setDottedProviderLine(lines, dottedProvider, "signet");
			changed = true;
		}
		if (block !== null && typeof block === "object" && block.provider !== null && block.provider !== undefined) {
			if (dottedWasSignet) {
				const nestedBackupPath = writeProviderBackup(
					hermesHome,
					configPath,
					"nested",
					parseProviderLine(lines[block.provider] ?? "") ?? "",
				);
				backupPath = nestedBackupPath ?? backupPath;
			}
			lines.splice(block.provider, 1);
			changed = true;
		}
		if (!changed) return { configPath: null, backupPath: null };
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`);
		return { configPath, backupPath };
	}
	if (content && block === null) {
		warnings.push(
			`Could not safely patch Hermes memory.provider in ${configPath}. Run: hermes config set memory.provider signet`,
		);
		return { configPath: null, backupPath: null };
	}

	if (block !== null && typeof block === "object" && block.provider !== null && block.provider !== undefined) {
		if (providerLineIsSignet(lines[block.provider] ?? "")) return { configPath: null, backupPath: null };
		backupPath = writeProviderBackup(
			hermesHome,
			configPath,
			"nested",
			parseProviderLine(lines[block.provider] ?? "") ?? "",
		);
		lines[block.provider] = `${(lines[block.provider] ?? "").match(/^\s*/)?.[0] ?? "  "}provider: signet`;
	} else if (block !== null && typeof block === "object") {
		lines.splice(block.start + 1, 0, `${" ".repeat(block.indent)}provider: signet`);
	} else {
		if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
		lines.push("memory:", "  provider: signet");
	}

	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`);
	return { configPath, backupPath };
}

function restoreOrClearProvider(hermesHome: string): { configPath: string | null; backupPath: string | null } {
	const config = readConfigYaml(hermesHome);
	if (!config) return { configPath: null, backupPath: removeProviderBackup(hermesHome) };
	const lines = config.content.replace(/\r\n/g, "\n").split("\n");
	const block = findMemoryBlock(lines);
	const dottedProvider = findDottedProvider(lines);
	const backup = readProviderBackup(hermesHome);
	let configChanged = false;
	if (dottedProvider !== null && dottedProviderLineIsSignet(lines[dottedProvider] ?? "")) {
		setDottedProviderLine(lines, dottedProvider, backup?.providerKind === "dotted" ? backup.previousProvider : "''");
		if (backup?.providerKind === "nested") {
			if (block !== null && typeof block === "object") {
				lines.splice(block.start + 1, 0, `${" ".repeat(block.indent)}provider: ${backup.previousProvider}`);
			} else {
				if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
				lines.push("memory:", `  provider: ${backup.previousProvider}`);
			}
		}
		configChanged = true;
	} else if (
		block !== null &&
		typeof block === "object" &&
		block.provider !== null &&
		block.provider !== undefined &&
		providerLineIsSignet(lines[block.provider] ?? "")
	) {
		lines[block.provider] = `${(lines[block.provider] ?? "").match(/^\s*/)?.[0] ?? "  "}provider: ${
			backup?.providerKind === "nested" ? backup.previousProvider : "''"
		}`;
		configChanged = true;
	}
	if (configChanged) {
		writeFileSync(config.path, `${lines.join("\n").replace(/\n+$/g, "")}\n`);
	}
	return {
		configPath: configChanged ? config.path : null,
		backupPath: removeProviderBackup(hermesHome),
	};
}

function pluginHasStaticToolSchemas(pluginFile: string): boolean {
	if (!existsSync(pluginFile)) return false;
	const content = readFileSync(pluginFile, "utf-8");
	return (
		content.includes("Hermes indexes memory-provider tool dispatch before provider") &&
		content.includes("return list(ALL_TOOL_SCHEMAS)") &&
		!/def get_tool_schemas[\s\S]{0,220}if not self\._client:[\s\S]{0,80}return \[\]/.test(content)
	);
}

function getConnectorPackageJsonPath(): string | null {
	const candidates = [
		join(__dirname, "..", "package.json"),
		join(__dirname, "..", "..", "package.json"),
		join(__dirname, "..", "..", "..", "package.json"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getConnectorVersion(): string {
	const packageJsonPath = getConnectorPackageJsonPath();
	if (!packageJsonPath) return "unknown";
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}

function computePluginSourceHash(): string {
	const sourceDir = getPluginSourceDir();
	const hash = createHash("sha256");
	for (const file of PLUGIN_FILES) {
		const path = join(sourceDir, file);
		hash.update(file);
		hash.update("\0");
		if (existsSync(path)) {
			hash.update(readFileSync(path));
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

function writeInstallMarker(targetDir: string, targetKind: InstallMarker["targetKind"]): string {
	const markerPath = join(targetDir, INSTALL_MARKER_FILE);
	const marker: InstallMarker = {
		connector: "@signet/connector-hermes-agent",
		schemaVersion: 1,
		connectorVersion: getConnectorVersion(),
		sourceHash: computePluginSourceHash(),
		targetKind,
		installedAt: new Date().toISOString(),
	};
	writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
	return markerPath;
}

function readInstallMarker(targetDir: string): InstallMarker | null {
	const markerPath = join(targetDir, INSTALL_MARKER_FILE);
	if (!existsSync(markerPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as Partial<InstallMarker>;
		if (
			parsed.connector === "@signet/connector-hermes-agent" &&
			parsed.schemaVersion === 1 &&
			typeof parsed.connectorVersion === "string" &&
			typeof parsed.sourceHash === "string" &&
			(parsed.targetKind === "user" || parsed.targetKind === "repo") &&
			typeof parsed.installedAt === "string"
		) {
			return parsed as InstallMarker;
		}
		return null;
	} catch {
		return null;
	}
}

function pluginMarkerIsFresh(targetDir: string): boolean {
	const marker = readInstallMarker(targetDir);
	return marker !== null && marker.sourceHash === computePluginSourceHash();
}

function pluginLooksCurrent(targetDir: string): boolean {
	return pluginHasStaticToolSchemas(join(targetDir, "__init__.py")) && pluginMarkerIsFresh(targetDir);
}

function probeHermesProvider(hermesRepo: string): HermesProbeResult {
	if (!existsSync(hermesRepo)) {
		return { ok: false, toolNames: [], error: `Hermes repo not found at ${hermesRepo}` };
	}

	const script = [
		"import json",
		"from plugins.memory import load_memory_provider",
		"from agent.memory_manager import MemoryManager",
		"provider = load_memory_provider('signet')",
		"manager = MemoryManager()",
		"manager.add_provider(provider)",
		"names = sorted(manager.get_all_tool_names())",
		"required = ['memory_search', 'memory_store', 'memory_get', 'memory_list', 'memory_modify', 'memory_forget', 'signet_session_search', 'recall', 'remember']",
		"print(json.dumps({'toolNames': names, 'missing': [name for name in required if name not in names]}))",
	].join("\n");

	const python = process.env.PYTHON?.trim() || "python";
	const result = spawnSync(python, ["-c", script], {
		cwd: hermesRepo,
		env: { ...process.env, PYTHONPATH: hermesRepo },
		encoding: "utf-8",
		timeout: 5_000,
	});

	if (result.error) {
		return { ok: false, toolNames: [], error: result.error.message };
	}
	if (result.status !== 0) {
		const err = `${result.stderr || result.stdout || `python exited ${result.status}`}`.trim();
		return { ok: false, toolNames: [], error: err };
	}

	try {
		const parsed = JSON.parse(result.stdout.trim()) as { toolNames?: unknown; missing?: unknown };
		const toolNames = Array.isArray(parsed.toolNames)
			? parsed.toolNames.filter((name): name is string => typeof name === "string")
			: [];
		const missing = Array.isArray(parsed.missing)
			? parsed.missing.filter((name): name is string => typeof name === "string")
			: [];
		return {
			ok: missing.length === 0,
			toolNames,
			error: missing.length > 0 ? `Missing tools: ${missing.join(", ")}` : null,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, toolNames: [], error: `Could not parse Hermes provider probe output: ${msg}` };
	}
}

async function checkDaemon(daemonUrl: string): Promise<{ ok: boolean; detail: string }> {
	const baseUrl = trimTrailingSlashes(daemonUrl);
	try {
		const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
		if (resp.ok) return { ok: true, detail: `${baseUrl}/health returned HTTP ${resp.status}` };
		return { ok: false, detail: `${baseUrl}/health returned HTTP ${resp.status}` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, detail: `${baseUrl}/health unreachable: ${msg}` };
	}
}

function sanitizedEnv(name: string): string {
	return (process.env[name]?.trim() || "").replace(/[\r\n]+/g, "");
}

function sanitizedAuthTokenEnv(): string {
	return sanitizedEnv("SIGNET_API_KEY") || sanitizedEnv("SIGNET_TOKEN");
}

function trustedOriginForDaemonUrl(daemonUrl: string): string | null {
	try {
		return new URL(daemonUrl).origin;
	} catch {
		return null;
	}
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

	const baseUrl = trimTrailingSlashes(daemonUrl);
	const token = sanitizedAuthTokenEnv();
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
		return resolveConfigPath(this.getHermesHome());
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
		let userPluginInstalled = false;
		let repoPluginInstalled = false;

		// 1. Install the Python plugin into the current user-plugin location.
		try {
			const pluginFiles = installPlugin(getUserPluginTargetDir(hermesHome), "user");
			filesWritten.push(...pluginFiles);
			userPluginInstalled = true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(`Failed to install Hermes user plugin files: ${msg}`);
		}

		// Bundled repo providers take precedence over user plugins in Hermes.
		// Refresh that copy too when the repo is discoverable so stale schemas
		// cannot shadow the fixed Signet provider.
		if (hermesRepo) {
			try {
				const pluginFiles = installPlugin(getRepoPluginTargetDir(hermesRepo), "repo");
				filesWritten.push(...pluginFiles);
				repoPluginInstalled = true;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				warnings.push(`Failed to refresh Hermes repo plugin files: ${msg}`);
			}
		}
		const usablePluginTargetInstalled = hermesRepo ? repoPluginInstalled : userPluginInstalled;
		if (!usablePluginTargetInstalled) {
			return {
				success: false,
				message: hermesRepo
					? "Hermes Agent integration failed — could not refresh the Hermes repo Signet provider"
					: "Hermes Agent integration failed — could not install the Hermes user Signet provider",
				filesWritten,
				configsPatched,
				warnings,
			};
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
			if (process.env.SIGNET_TRUSTED_DAEMON_ORIGINS) {
				signetVars.SIGNET_TRUSTED_DAEMON_ORIGINS = sanitizedEnv("SIGNET_TRUSTED_DAEMON_ORIGINS");
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
			const authToken = sanitizedAuthTokenEnv();
			if (authToken) {
				signetVars.SIGNET_API_KEY = authToken;
				signetVars.SIGNET_TOKEN = authToken;
				if (process.env.SIGNET_DAEMON_URL && !signetVars.SIGNET_TRUSTED_DAEMON_ORIGINS) {
					const trustedOrigin = trustedOriginForDaemonUrl(configuredDaemonUrl);
					if (trustedOrigin) {
						signetVars.SIGNET_TRUSTED_DAEMON_ORIGINS = trustedOrigin;
					} else {
						warnings.push(
							`Could not derive trusted daemon origin from SIGNET_DAEMON_URL='${configuredDaemonUrl}'. Set SIGNET_TRUSTED_DAEMON_ORIGINS explicitly if Hermes must send SIGNET_API_KEY to this daemon.`,
						);
					}
				}
			} else if (
				process.env.SIGNET_DAEMON_URL &&
				!process.env.SIGNET_DAEMON_URL.includes("localhost") &&
				!process.env.SIGNET_DAEMON_URL.includes("127.0.0.1")
			) {
				warnings.push(
					`SIGNET_API_KEY is not set. The Signet daemon at ${process.env.SIGNET_DAEMON_URL} may require authentication. Set SIGNET_API_KEY in your environment before starting Hermes.`,
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

		// 3. Activate Signet as the external Hermes memory provider.
		const providerConfig = configureProvider(hermesHome, warnings);
		if (providerConfig.configPath) {
			configsPatched.push(providerConfig.configPath);
		}
		if (providerConfig.backupPath) {
			filesWritten.push(providerConfig.backupPath);
		}
		if (!isProviderConfigured(hermesHome)) {
			return {
				success: false,
				message:
					"Hermes Agent integration incomplete — Signet provider was deployed but not activated in Hermes config",
				filesWritten,
				configsPatched,
				warnings,
			};
		}

		if (hermesRepo) {
			const probe = probeHermesProvider(hermesRepo);
			if (!probe.ok) {
				warnings.push(
					`Hermes Signet provider installed, but Hermes did not expose all Signet memory tools during verification: ${probe.error ?? "unknown error"}. Run: signet doctor hermes`,
				);
			}
		} else {
			warnings.push(
				"Hermes repo was not found, so install-time provider verification was skipped. Run: signet doctor hermes",
			);
		}

		const message = "Hermes Agent integration installed — Signet memory provider deployed and activated";

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
			const removed = uninstallPlugin(getRepoPluginTargetDir(hermesRepo));
			filesRemoved.push(...removed);
		}

		// Clean up env vars
		const hermesHome = this.getHermesHome();
		const userPluginRemoved = uninstallPlugin(getUserPluginTargetDir(hermesHome));
		filesRemoved.push(...userPluginRemoved);

		const providerConfig = restoreOrClearProvider(hermesHome);
		if (providerConfig.configPath) {
			configsPatched.push(providerConfig.configPath);
		}
		if (providerConfig.backupPath) {
			filesRemoved.push(providerConfig.backupPath);
		}

		const envPath = join(hermesHome, ".env");
		if (existsSync(envPath)) {
			try {
				let envContent = readFileSync(envPath, "utf-8");
				let changed = false;
				for (const key of [
					"SIGNET_DAEMON_URL",
					"SIGNET_TRUSTED_DAEMON_ORIGINS",
					"SIGNET_AGENT_ID",
					"SIGNET_AGENT_WORKSPACE",
					"SIGNET_API_KEY",
					"SIGNET_TOKEN",
				]) {
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
		const hermesHome = this.getHermesHome();
		const hermesRepo = this.getHermesRepo();
		if (!isProviderConfigured(hermesHome)) return false;
		if (hermesRepo) return pluginLooksCurrent(getRepoPluginTargetDir(hermesRepo));
		return pluginLooksCurrent(getUserPluginTargetDir(hermesHome));
	}

	async diagnose(): Promise<HermesDoctorReport> {
		const hermesHome = this.getHermesHome();
		const hermesRepo = this.getHermesRepo();
		return diagnoseHermesIntegration({
			hermesHome,
			hermesRepo,
			daemonUrl: (process.env.SIGNET_DAEMON_URL?.trim() || "http://localhost:3850").replace(/[\r\n]+/g, ""),
		});
	}
}

export async function diagnoseHermesIntegration(opts?: {
	readonly hermesHome?: string;
	readonly hermesRepo?: string | null;
	readonly daemonUrl?: string;
}): Promise<HermesDoctorReport> {
	const hermesHome = opts?.hermesHome ?? resolveHermesHomePath();
	const hermesRepo = opts && "hermesRepo" in opts ? (opts.hermesRepo ?? null) : resolveHermesRepoPath();
	const daemonUrl = opts?.daemonUrl ?? (process.env.SIGNET_DAEMON_URL?.trim() || "http://localhost:3850");
	const configPath = resolveConfigPath(hermesHome);
	const userPluginDir = getUserPluginTargetDir(hermesHome);
	const repoPluginDir = hermesRepo ? getRepoPluginTargetDir(hermesRepo) : null;
	const checks: HermesDiagnosticCheck[] = [];
	const warnings: string[] = [];
	const userPluginCurrent = pluginLooksCurrent(userPluginDir);
	const repoPluginCurrent = repoPluginDir ? pluginLooksCurrent(repoPluginDir) : false;
	const probe = hermesRepo
		? probeHermesProvider(hermesRepo)
		: userPluginCurrent
			? { ok: true, toolNames: REQUIRED_TOOL_NAMES, error: null }
			: { ok: false, toolNames: [], error: "Hermes repo not found and user plugin is missing or stale" };
	const daemon = await checkDaemon(daemonUrl);

	checks.push({
		id: "daemon-health",
		label: "Signet daemon",
		ok: daemon.ok,
		detail: daemon.detail,
		fix: daemon.ok ? undefined : "Run `signet daemon start`, then retry `signet doctor hermes`.",
	});
	checks.push({
		id: "provider-config",
		label: "Hermes memory provider",
		ok: isProviderConfigured(hermesHome),
		detail: existsSync(configPath)
			? `${configPath} ${isProviderConfigured(hermesHome) ? "sets" : "does not set"} memory.provider=signet`
			: `${configPath} does not exist`,
		fix: isProviderConfigured(hermesHome) ? undefined : "Run `signet setup --harness hermes-agent`.",
	});
	checks.push({
		id: "user-plugin",
		label: "User plugin copy",
		ok: userPluginCurrent,
		detail: userPluginCurrent
			? `${userPluginDir} matches bundled Signet plugin`
			: `${userPluginDir} is missing or stale`,
		fix: userPluginCurrent ? undefined : "Run `signet setup --harness hermes-agent`.",
	});
	checks.push({
		id: "repo-plugin",
		label: "Hermes repo plugin copy",
		ok: repoPluginDir === null || repoPluginCurrent,
		detail:
			repoPluginDir === null
				? "Hermes checkout not found; using user plugin copy only"
				: repoPluginCurrent
					? `${repoPluginDir} matches bundled Signet plugin`
					: `${repoPluginDir} is missing or stale`,
		fix:
			repoPluginDir === null || repoPluginCurrent
				? undefined
				: "Set HERMES_REPO to the Hermes Agent checkout, then run `signet setup --harness hermes-agent`.",
	});
	checks.push({
		id: "tool-routing",
		label: "Hermes tool routing",
		ok: probe.ok,
		detail: probe.ok
			? hermesRepo
				? `Hermes exposes ${REQUIRED_TOOL_NAMES.join(", ")}`
				: `User plugin advertises ${REQUIRED_TOOL_NAMES.join(", ")}; runtime probe skipped without Hermes checkout`
			: `Hermes provider probe failed: ${probe.error ?? "unknown error"}`,
		fix: probe.ok
			? undefined
			: "Run `signet setup --harness hermes-agent`; if this stays broken, restart Hermes after install.",
	});

	if (!hermesRepo) {
		warnings.push(
			"Hermes checkout was not found; repo-plugin install is optional, and runtime tool-routing probes need HERMES_REPO or ~/.hermes/hermes-agent.",
		);
	}

	return {
		ok: checks.every((check) => check.ok),
		hermesHome,
		hermesRepo,
		configPath,
		userPluginDir,
		repoPluginDir,
		toolNames: probe.toolNames,
		checks,
		warnings,
	};
}

export function createConnector(): HermesAgentConnector {
	return new HermesAgentConnector();
}

export default HermesAgentConnector;
