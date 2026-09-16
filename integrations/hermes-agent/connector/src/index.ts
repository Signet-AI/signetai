import { spawnSyncHidden as spawnSync } from "@signet/core";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseConnector, type InstallResult, type UninstallResult, resolveSignetApiKey } from "@signet/connector-base";
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
	// Native binaries materialize embedded connector assets into a stable,
	// content-addressed tree before loading the CLI.
	const connectorAssetsDir = process.env.SIGNET_CONNECTOR_ASSETS_DIR?.trim();
	if (connectorAssetsDir) {
		const fromEmbeddedAssets = join(connectorAssetsDir, "hermes-agent", "hermes-plugin");
		if (existsSync(fromEmbeddedAssets)) return fromEmbeddedAssets;
	}
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

export interface HermesConnectorOptions {
	readonly profile?: string;
	readonly agentId?: string;
	readonly memoryPolicy?: "isolated" | "shared" | "group";
	readonly policyGroup?: string;
}

export interface HermesConnectorTarget {
	readonly profile?: string;
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

const DESCRIPTOR_ROOT =
	process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : null;
const DESCRIPTOR_WRITES_SUPPORTED =
	DESCRIPTOR_ROOT !== null && typeof constants.O_DIRECTORY === "number" && typeof constants.O_NOFOLLOW === "number";
const DESCRIPTOR_WRITE_UNAVAILABLE_ERROR =
	"Targeted Hermes profile writes require descriptor-backed no-follow filesystem support";

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function descriptorPath(fd: number): string {
	if (DESCRIPTOR_ROOT === null) throw new Error(DESCRIPTOR_WRITE_UNAVAILABLE_ERROR);
	return join(DESCRIPTOR_ROOT, String(fd));
}

function isPathWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

function openDirectoryNoFollow(path: string): number {
	if (!DESCRIPTOR_WRITES_SUPPORTED) throw new Error(DESCRIPTOR_WRITE_UNAVAILABLE_ERROR);
	return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function closeDirectory(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// Preserve the original filesystem error when cleanup also fails.
	}
}

const SECURE_REMOVAL_CHANGED_STATUS = 75;
// Node exposes descriptor-relative reads poorly and has no unlinkat/rmdirat wrapper.
// Python's dir_fd APIs provide the atomic parent-relative removal primitive needed here.
const SECURE_REMOVAL_SCRIPT = [
	"import os, sys",
	"expected_dev = int(sys.argv[1])",
	"expected_ino = int(sys.argv[2])",
	"operation = sys.argv[3]",
	"name = sys.argv[4]",
	"try:",
	"    current = os.stat(name, dir_fd=3, follow_symlinks=False)",
	"except FileNotFoundError:",
	"    raise SystemExit(75)",
	"if current.st_dev != expected_dev or current.st_ino != expected_ino:",
	"    raise SystemExit(75)",
	"try:",
	"    if operation == 'directory':",
	"        os.rmdir(name, dir_fd=3)",
	"    else:",
	"        os.unlink(name, dir_fd=3)",
	"except FileNotFoundError:",
	"    raise SystemExit(75)",
].join("\n");

function getPythonCandidates(): readonly { readonly command: string; readonly args: readonly string[] }[] {
	const configuredPython = process.env.PYTHON?.trim();
	if (configuredPython) return [{ command: configuredPython, args: [] }];
	return process.platform === "win32"
		? [
				{ command: "py", args: ["-3"] },
				{ command: "python", args: [] },
			]
		: [
				{ command: "python3", args: [] },
				{ command: "python", args: [] },
			];
}

function removeEntryNoFollow(
	parentFd: number,
	name: string,
	expectedDev: number,
	expectedIno: number,
	directory: boolean,
): void {
	const errors: string[] = [];
	for (const candidate of getPythonCandidates()) {
		const result = spawnSync(
			candidate.command,
			[
				...candidate.args,
				"-c",
				SECURE_REMOVAL_SCRIPT,
				String(expectedDev),
				String(expectedIno),
				directory ? "directory" : "file",
				name,
			],
			{
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe", parentFd],
				timeout: 5_000,
			},
		);

		if (result.error) {
			errors.push(`${candidate.command}: ${result.error.message}`);
			continue;
		}
		if (result.status === 0) return;
		if (result.status === SECURE_REMOVAL_CHANGED_STATUS) {
			throw new Error(`Hermes directory entry changed during secure removal: ${name}`);
		}
		errors.push(`${candidate.command}: exited ${result.status ?? "without a status"}`);
	}
	throw new Error(`${DESCRIPTOR_WRITE_UNAVAILABLE_ERROR}: ${errors.join("; ") || "No Python interpreter found"}`);
}

function sameStatIdentity(
	left: { readonly dev: number; readonly ino: number },
	right: { readonly dev: number; readonly ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function ensureContainedDirectory(directory: string, targetRoot: string): void {
	const safeDirectory = resolveContainedWritePath(directory, targetRoot);
	if (!DESCRIPTOR_WRITES_SUPPORTED) {
		throw new Error(DESCRIPTOR_WRITE_UNAVAILABLE_ERROR);
	}

	const absoluteDirectory = resolvePath(directory);
	const rootPath = resolvePath(targetRoot);
	if (!isPathWithin(rootPath, safeDirectory)) {
		throw new Error(`Hermes target directory escapes validated root: ${directory}`);
	}

	let existing = absoluteDirectory;
	const missing: string[] = [];
	while (!pathEntryExists(existing)) {
		const parent = dirname(existing);
		if (parent === existing) throw new Error(`Hermes target directory has no existing ancestor: ${directory}`);
		missing.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	const existingReal = realpathSync(existing);
	if (existingReal !== existing) {
		throw new Error(`Hermes target directory is symlinked and cannot be used for writes: ${directory}`);
	}

	let fd = openDirectoryNoFollow(existing);
	let expected = existingReal;
	try {
		for (const component of missing) {
			const childPath = join(descriptorPath(fd), component);
			try {
				mkdirSync(childPath);
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
				if (code !== "EEXIST") throw error;
			}
			const childFd = openDirectoryNoFollow(childPath);
			try {
				expected = join(expected, component);
				if (realpathSync(descriptorPath(childFd)) !== expected) {
					throw new Error(`Hermes target directory changed during secure creation: ${directory}`);
				}
			} catch (error) {
				closeDirectory(childFd);
				throw error;
			}
			closeDirectory(fd);
			fd = childFd;
		}
	} finally {
		closeDirectory(fd);
	}
}

function writeContainedFile(targetPath: string, content: string | Uint8Array, targetRoot: string): void {
	const safePath = resolveContainedWritePath(targetPath, targetRoot);
	if (!DESCRIPTOR_WRITES_SUPPORTED) {
		throw new Error(DESCRIPTOR_WRITE_UNAVAILABLE_ERROR);
	}

	const rootPath = resolvePath(targetRoot);
	ensureContainedDirectory(dirname(safePath), targetRoot);
	const relativePath = relative(rootPath, safePath);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Hermes target file escapes validated root: ${targetPath}`);
	}
	const components = relativePath.split(sep);
	const fileName = components.pop();
	if (!fileName || components.some((component) => component === "" || component === "." || component === "..")) {
		throw new Error(`Hermes target file has an invalid relative path: ${targetPath}`);
	}

	let parentFd = openDirectoryNoFollow(rootPath);
	try {
		if (realpathSync(descriptorPath(parentFd)) !== rootPath) {
			throw new Error(`Hermes target root changed during secure write: ${targetRoot}`);
		}
		let expected = rootPath;
		for (const component of components) {
			const childFd = openDirectoryNoFollow(join(descriptorPath(parentFd), component));
			try {
				expected = join(expected, component);
				if (realpathSync(descriptorPath(childFd)) !== expected) {
					throw new Error(`Hermes target directory changed during secure write: ${targetPath}`);
				}
			} catch (error) {
				closeDirectory(childFd);
				throw error;
			}
			closeDirectory(parentFd);
			parentFd = childFd;
		}

		const filePath = join(descriptorPath(parentFd), fileName);
		let existingFileIdentity: { readonly dev: number; readonly ino: number } | undefined;
		try {
			const existing = lstatSync(filePath);
			if (existing.isSymbolicLink()) {
				throw new Error(`Hermes target file is symlinked and cannot be used for writes: ${targetPath}`);
			}
			existingFileIdentity = { dev: existing.dev, ino: existing.ino };
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") throw error;
		}

		const fileFd = openSync(
			filePath,
			constants.O_WRONLY |
				constants.O_NOFOLLOW |
				(existingFileIdentity === undefined ? constants.O_CREAT | constants.O_EXCL : 0),
			0o666,
		);
		try {
			const expectedFile = join(expected, fileName);
			if (existingFileIdentity !== undefined && !sameStatIdentity(existingFileIdentity, fstatSync(fileFd))) {
				throw new Error(`Hermes target file changed during secure write: ${targetPath}`);
			}
			if (realpathSync(descriptorPath(fileFd)) !== expectedFile) {
				throw new Error(`Hermes target file changed during secure write: ${targetPath}`);
			}
			ftruncateSync(fileFd, 0);
			const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			let offset = 0;
			while (offset < bytes.length) {
				const written = writeSync(fileFd, bytes, offset, bytes.length - offset);
				if (written <= 0) throw new Error(`Hermes target file write made no progress: ${targetPath}`);
				offset += written;
			}
		} finally {
			closeDirectory(fileFd);
		}
	} finally {
		closeDirectory(parentFd);
	}
}

function ensureTargetDirectory(directory: string, targetRoot: string): void {
	ensureContainedDirectory(directory, targetRoot);
}

function writeTargetFile(path: string, content: string | Uint8Array, targetRoot: string): void {
	writeContainedFile(path, content, targetRoot);
}

function rejectSymlinkedPathComponents(path: string, root: string, targetPath: string): void {
	if (!isPathWithin(root, path)) {
		throw new Error(`Hermes target path escapes validated root: ${targetPath}`);
	}
	let current = path;
	while (true) {
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error(`Hermes target path is symlinked and cannot be used for writes: ${targetPath}`);
		}
		if (current === root) return;
		const parent = dirname(current);
		if (parent === current) throw new Error(`Hermes target path escapes validated root: ${targetPath}`);
		current = parent;
	}
}

function resolveContainedWritePath(targetPath: string, targetRoot: string): string {
	let rootPath = resolvePath(targetRoot);
	while (!pathEntryExists(rootPath)) {
		const parent = dirname(rootPath);
		if (parent === rootPath) throw new Error(`Hermes target root does not exist: ${targetRoot}`);
		rootPath = parent;
	}
	if (realpathSync(rootPath) !== rootPath) {
		throw new Error(`Hermes target root is symlinked and cannot be used for writes: ${targetRoot}`);
	}
	const root = realpathSync(rootPath);
	let existing = resolvePath(targetPath);
	const missing: string[] = [];
	while (!pathEntryExists(existing)) {
		const parent = dirname(existing);
		if (parent === existing) throw new Error(`Hermes target path does not have an existing ancestor: ${targetPath}`);
		missing.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	rejectSymlinkedPathComponents(existing, rootPath, targetPath);
	const candidate = join(existing, ...missing);
	const rel = relative(root, candidate);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Hermes target path escapes validated root: ${targetPath}`);
	}
	return candidate;
}

function removeDirectoryContentsNoFollow(directoryFd: number): void {
	for (const entry of readdirSync(descriptorPath(directoryFd), { withFileTypes: true })) {
		const childPath = join(descriptorPath(directoryFd), entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			const childFd = openDirectoryNoFollow(childPath);
			try {
				const childIdentity = fstatSync(childFd);
				removeDirectoryContentsNoFollow(childFd);
				removeEntryNoFollow(directoryFd, entry.name, childIdentity.dev, childIdentity.ino, true);
			} finally {
				closeDirectory(childFd);
			}
			continue;
		}
		const childIdentity = lstatSync(childPath);
		removeEntryNoFollow(directoryFd, entry.name, childIdentity.dev, childIdentity.ino, false);
	}
}

function removeContainedDirectory(
	targetPath: string,
	targetRoot: string,
	targetKind: InstallMarker["targetKind"],
): void {
	if (!DESCRIPTOR_WRITES_SUPPORTED) throw new Error(DESCRIPTOR_WRITE_UNAVAILABLE_ERROR);
	const safeTargetDir = resolveContainedWritePath(targetPath, targetRoot);
	const rootPath = resolvePath(targetRoot);
	const relativePath = relative(rootPath, safeTargetDir);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Hermes target directory escapes validated root: ${targetPath}`);
	}
	const components = relativePath.split(sep);
	const targetName = components.pop();
	if (!targetName || components.some((component) => component === "" || component === "." || component === "..")) {
		throw new Error(`Hermes target directory has an invalid relative path: ${targetPath}`);
	}

	let parentFd = openDirectoryNoFollow(rootPath);
	try {
		let expected = rootPath;
		for (const component of components) {
			const childFd = openDirectoryNoFollow(join(descriptorPath(parentFd), component));
			try {
				expected = join(expected, component);
				if (realpathSync(descriptorPath(childFd)) !== expected) {
					throw new Error(`Hermes target directory changed during secure removal: ${targetPath}`);
				}
			} catch (error) {
				closeDirectory(childFd);
				throw error;
			}
			closeDirectory(parentFd);
			parentFd = childFd;
		}

		const targetEntryPath = join(descriptorPath(parentFd), targetName);
		const targetFd = openDirectoryNoFollow(targetEntryPath);
		try {
			const targetIdentity = fstatSync(targetFd);
			const expectedTarget = join(expected, targetName);
			if (realpathSync(descriptorPath(targetFd)) !== expectedTarget) {
				throw new Error(`Hermes target directory changed during secure removal: ${targetPath}`);
			}
			const marker = readInstallMarkerFromDirectory(targetFd);
			if (marker === null || marker.targetKind !== targetKind) {
				throw new Error(
					`Refusing to uninstall unowned Hermes plugin path: ${targetPath} (missing or invalid ${INSTALL_MARKER_FILE})`,
				);
			}
			removeDirectoryContentsNoFollow(targetFd);
			removeEntryNoFollow(parentFd, targetName, targetIdentity.dev, targetIdentity.ino, true);
		} finally {
			closeDirectory(targetFd);
		}
	} finally {
		closeDirectory(parentFd);
	}
}

function removeContainedFile(targetPath: string, targetRoot: string): void {
	if (!DESCRIPTOR_WRITES_SUPPORTED) throw new Error(DESCRIPTOR_WRITE_UNAVAILABLE_ERROR);
	const safeTargetPath = resolveContainedWritePath(targetPath, targetRoot);
	const rootPath = resolvePath(targetRoot);
	const relativePath = relative(rootPath, safeTargetPath);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Hermes target file escapes validated root: ${targetPath}`);
	}
	const components = relativePath.split(sep);
	const fileName = components.pop();
	if (!fileName || components.some((component) => component === "" || component === "." || component === "..")) {
		throw new Error(`Hermes target file has an invalid relative path: ${targetPath}`);
	}

	let parentFd = openDirectoryNoFollow(rootPath);
	try {
		let expected = rootPath;
		for (const component of components) {
			const childFd = openDirectoryNoFollow(join(descriptorPath(parentFd), component));
			try {
				expected = join(expected, component);
				if (realpathSync(descriptorPath(childFd)) !== expected) {
					throw new Error(`Hermes target file changed during secure removal: ${targetPath}`);
				}
			} catch (error) {
				closeDirectory(childFd);
				throw error;
			}
			closeDirectory(parentFd);
			parentFd = childFd;
		}
		const targetFile = lstatSync(join(descriptorPath(parentFd), fileName));
		removeEntryNoFollow(parentFd, fileName, targetFile.dev, targetFile.ino, false);
	} finally {
		closeDirectory(parentFd);
	}
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
function installPlugin(targetDir: string, targetKind: InstallMarker["targetKind"], targetRoot: string): string[] {
	const writeDir = resolveContainedWritePath(targetDir, targetRoot);
	const sourceDir = getPluginSourceDir();

	ensureTargetDirectory(writeDir, targetRoot);

	const written: string[] = [];

	for (const file of PLUGIN_FILES) {
		const src = join(sourceDir, file);
		const dst = resolveContainedWritePath(join(writeDir, file), targetRoot);
		if (existsSync(src)) {
			writeTargetFile(dst, readFileSync(src), targetRoot);
			written.push(dst);
		}
	}
	written.push(writeInstallMarker(writeDir, targetKind, targetRoot));

	return written;
}

/** Remove the Signet memory plugin from the Hermes plugins directory. */
function uninstallPlugin(targetDir: string, targetKind: InstallMarker["targetKind"], targetRoot: string): string[] {
	if (!pathEntryExists(targetDir)) return [];
	removeContainedDirectory(targetDir, targetRoot, targetKind);
	return [targetDir];
}

// ---------------------------------------------------------------------------
// Config patching
// ---------------------------------------------------------------------------

function getConfigCandidates(hermesHome: string, targetRoot?: string): string[] {
	const candidates = [join(hermesHome, "config.yaml"), join(hermesHome, "cli-config.yaml")];
	return targetRoot ? candidates.map((candidate) => resolveContainedWritePath(candidate, targetRoot)) : candidates;
}

function resolveConfigPath(hermesHome: string, targetRoot?: string): string {
	for (const candidate of getConfigCandidates(hermesHome, targetRoot)) {
		if (existsSync(candidate)) return candidate;
	}
	const fallback = join(hermesHome, "config.yaml");
	return targetRoot ? resolveContainedWritePath(fallback, targetRoot) : fallback;
}

function readConfigYaml(hermesHome: string, targetRoot?: string): { path: string; content: string } | null {
	const configPath = resolveConfigPath(hermesHome, targetRoot);
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
	targetRoot: string,
): string | null {
	if (previousProvider === "signet") return null;
	const backupPath = resolveContainedWritePath(getProviderBackupPath(hermesHome), targetRoot);
	if (pathEntryExists(backupPath)) return null;
	const backup: ProviderBackup = {
		schemaVersion: 1,
		configPath,
		providerKind,
		previousProvider,
		createdAt: new Date().toISOString(),
	};
	ensureTargetDirectory(dirname(backupPath), targetRoot);
	writeTargetFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, targetRoot);
	return backupPath;
}

function readProviderBackup(hermesHome: string, targetRoot?: string): ProviderBackup | null {
	const backupPath = targetRoot
		? resolveContainedWritePath(getProviderBackupPath(hermesHome), targetRoot)
		: getProviderBackupPath(hermesHome);
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

function removeProviderBackup(hermesHome: string, targetRoot: string): string | null {
	const backupPath = resolveContainedWritePath(getProviderBackupPath(hermesHome), targetRoot);
	if (!pathEntryExists(backupPath)) return null;
	try {
		removeContainedFile(backupPath, targetRoot);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code !== "ENOENT") throw error;
		return null;
	}
	return backupPath;
}

function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) {
		end--;
	}
	return value.slice(0, end);
}

function isProviderConfigured(hermesHome: string, targetRoot?: string): boolean {
	const config = readConfigYaml(hermesHome, targetRoot);
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
	targetRoot: string,
): { configPath: string | null; backupPath: string | null } {
	const configPath = resolveConfigPath(hermesHome, targetRoot);
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
				targetRoot,
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
					targetRoot,
				);
				backupPath = nestedBackupPath ?? backupPath;
			}
			lines.splice(block.provider, 1);
			changed = true;
		}
		if (!changed) return { configPath: null, backupPath: null };
		ensureTargetDirectory(dirname(configPath), targetRoot);
		writeTargetFile(configPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`, targetRoot);
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
			targetRoot,
		);
		lines[block.provider] = `${(lines[block.provider] ?? "").match(/^\s*/)?.[0] ?? "  "}provider: signet`;
	} else if (block !== null && typeof block === "object") {
		lines.splice(block.start + 1, 0, `${" ".repeat(block.indent)}provider: signet`);
	} else {
		if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
		lines.push("memory:", "  provider: signet");
	}

	ensureTargetDirectory(dirname(configPath), targetRoot);
	writeTargetFile(configPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`, targetRoot);
	return { configPath, backupPath };
}

function restoreOrClearProvider(
	hermesHome: string,
	targetRoot: string,
): { configPath: string | null; backupPath: string | null } {
	const safeConfigPath = resolveContainedWritePath(resolveConfigPath(hermesHome), targetRoot);
	const config = readConfigYaml(hermesHome, targetRoot);
	if (!config) return { configPath: null, backupPath: removeProviderBackup(hermesHome, targetRoot) };
	const lines = config.content.replace(/\r\n/g, "\n").split("\n");
	const block = findMemoryBlock(lines);
	const dottedProvider = findDottedProvider(lines);
	const backup = readProviderBackup(hermesHome, targetRoot);
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
		writeTargetFile(safeConfigPath, `${lines.join("\n").replace(/\n+$/g, "")}\n`, targetRoot);
	}
	return {
		configPath: configChanged ? safeConfigPath : null,
		backupPath: removeProviderBackup(hermesHome, targetRoot),
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
	const runtimeVersion = process.env.SIGNET_VERSION?.trim();
	if (runtimeVersion) return runtimeVersion;
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

function writeInstallMarker(targetDir: string, targetKind: InstallMarker["targetKind"], targetRoot: string): string {
	const markerPath = resolveContainedWritePath(join(targetDir, INSTALL_MARKER_FILE), targetRoot);
	const marker: InstallMarker = {
		connector: "@signet/connector-hermes-agent",
		schemaVersion: 1,
		connectorVersion: getConnectorVersion(),
		sourceHash: computePluginSourceHash(),
		targetKind,
		installedAt: new Date().toISOString(),
	};
	writeTargetFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, targetRoot);
	return markerPath;
}

function parseInstallMarker(content: string): InstallMarker | null {
	try {
		const parsed = JSON.parse(content) as Partial<InstallMarker>;
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
	} catch {
		// Invalid marker contents are treated as unowned.
	}
	return null;
}

function readInstallMarker(targetDir: string): InstallMarker | null {
	const markerPath = join(targetDir, INSTALL_MARKER_FILE);
	if (!existsSync(markerPath)) return null;
	try {
		return parseInstallMarker(readFileSync(markerPath, "utf-8"));
	} catch {
		return null;
	}
}

function readInstallMarkerFromDirectory(directoryFd: number): InstallMarker | null {
	let markerFd: number | undefined;
	try {
		markerFd = openSync(
			join(descriptorPath(directoryFd), INSTALL_MARKER_FILE),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		return parseInstallMarker(readFileSync(markerFd, "utf-8"));
	} catch {
		return null;
	} finally {
		if (markerFd !== undefined) closeDirectory(markerFd);
	}
}

function pluginMarkerIsFresh(targetDir: string): boolean {
	const marker = readInstallMarker(targetDir);
	return marker !== null && marker.sourceHash === computePluginSourceHash();
}

function pluginLooksCurrent(targetDir: string, targetRoot?: string): boolean {
	let safeTargetDir = targetDir;
	if (targetRoot) {
		try {
			safeTargetDir = resolveContainedWritePath(targetDir, targetRoot);
		} catch {
			return false;
		}
	}
	return pluginHasStaticToolSchemas(join(safeTargetDir, "__init__.py")) && pluginMarkerIsFresh(safeTargetDir);
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

	const configuredPython = process.env.PYTHON?.trim();
	const candidates = configuredPython
		? [{ command: configuredPython, args: [] }]
		: process.platform === "win32"
			? [
					{ command: "py", args: ["-3"] },
					{ command: "python", args: [] },
					{ command: "python3", args: [] },
				]
			: [
					{ command: "python3", args: [] },
					{ command: "python", args: [] },
				];
	const errors: string[] = [];

	for (const candidate of candidates) {
		const result = spawnSync(candidate.command, [...candidate.args, "-c", script], {
			cwd: hermesRepo,
			env: { ...process.env, PYTHONPATH: hermesRepo },
			encoding: "utf-8",
			timeout: 5_000,
		});

		if (result.error) {
			errors.push(`${candidate.command}: ${result.error.message}`);
			continue;
		}
		if (result.status !== 0) {
			const err = `${result.stderr || result.stdout || `${candidate.command} exited ${result.status}`}`.trim();
			errors.push(`${candidate.command}: ${err}`);
			continue;
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
			errors.push(`${candidate.command}: Could not parse Hermes provider probe output: ${msg}`);
		}
	}

	return { ok: false, toolNames: [], error: errors.join("; ") || "No Python interpreter found" };
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
	return resolveSignetApiKey() ?? "";
}

function trustedOriginForDaemonUrl(daemonUrl: string): string | null {
	try {
		return new URL(daemonUrl).origin;
	} catch {
		return null;
	}
}

type AgentReadPolicy = "isolated" | "shared" | "group";

function configuredAgentReadPolicy(warnings: string[], options: HermesConnectorOptions = {}): AgentReadPolicy {
	if (options.memoryPolicy) return options.memoryPolicy;
	const raw = sanitizedEnv("SIGNET_AGENT_READ_POLICY") || sanitizedEnv("SIGNET_AGENT_MEMORY_POLICY");
	if (!raw) return "shared";
	if (raw === "isolated" || raw === "shared" || raw === "group") return raw;
	warnings.push(`Ignoring unsupported SIGNET_AGENT_READ_POLICY '${raw}'. Expected one of: isolated, shared, group.`);
	return "shared";
}

/**
 * Resolve the daemon's configured agent id from `/api/status`.
 *
 * The daemon resolves its agent id from its own `SIGNET_AGENT_ID`, falling
 * back to `default` (see `platform/daemon/src/agent-id.ts`). This is the
 * workspace's real agent scope, which is what the plugin inherits when no
 * explicit agent id is set. Returns null when the daemon is unreachable or
 * reports none, so callers fall back to `default`.
 */
async function resolveDaemonAgentId(daemonUrl: string): Promise<string | null> {
	try {
		const baseUrl = trimTrailingSlashes(daemonUrl);
		const token = sanitizedAuthTokenEnv();
		const headers: Record<string, string> = {};
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		const resp = await fetch(`${baseUrl}/api/status`, {
			headers,
			signal: AbortSignal.timeout(1_000),
		});
		if (!resp.ok) return null;
		const body = (await resp.json()) as { agentId?: unknown };
		const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
		return agentId || null;
	} catch {
		// Daemon offline or still starting — caller falls back to "default".
		return null;
	}
}

async function ensureNamedAgentRegistered(
	daemonUrl: string,
	agentId: string,
	warnings: string[],
	options: HermesConnectorOptions = {},
): Promise<string | null> {
	if (!agentId || agentId === "default" || agentId === "hermes-agent") return null;
	if (process.env.SIGNET_SKIP_AGENT_REGISTER === "1") return null;

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
		if (getResp.ok) return null;
		if (getResp.status !== 404) {
			const body = await getResp.text();
			warnings.push(
				`Could not check Signet agent '${agentId}' before registration: HTTP ${getResp.status} ${body.slice(0, 200)}`,
			);
			return null;
		}
	} catch {
		// Daemon may be offline; the POST below will produce the user-facing warning.
	}

	const readPolicy = configuredAgentReadPolicy(warnings, options);
	const policyGroup =
		readPolicy === "group" ? options.policyGroup?.trim() || sanitizedEnv("SIGNET_AGENT_POLICY_GROUP") || null : null;
	if (readPolicy === "group" && !policyGroup) {
		return `Group memory policy for '${agentId}' requires --group or SIGNET_AGENT_POLICY_GROUP.`;
	}
	const effectiveReadPolicy: AgentReadPolicy = readPolicy;
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
			return `Could not register Signet agent '${agentId}' with ${effectiveReadPolicy} memory policy: ${body.slice(0, 200)}. ${policyHint}`;
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return `Could not register Signet agent '${agentId}' because the daemon was unreachable. ${policyHint} (${msg})`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class HermesAgentConnector extends BaseConnector {
	readonly name = "Hermes Agent";
	readonly harnessId = "hermes-agent";

	getIconAsset(): string {
		return "hermes-agent.svg";
	}

	private readonly target?: HermesConnectorTarget;

	constructor(target?: HermesConnectorTarget) {
		super();
		this.target = target;
	}

	private getHermesHome(): string {
		if (this.target?.profile) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(this.target.profile)) {
				throw new Error("Invalid Hermes profile name; use 1-64 letters, numbers, '.', '_' or '-'.");
			}
			const hermesHome = resolveHermesHomePath();
			const profileHome = join(hermesHome, "profiles", this.target.profile);
			return resolveContainedWritePath(profileHome, join(hermesHome, "profiles"));
		}
		return resolveHermesHomePath();
	}

	private getHermesRepo(): string | null {
		if (this.target?.profile) return null;
		return resolveHermesRepoPath();
	}

	getConfigPath(): string {
		const hermesHome = this.getHermesHome();
		return resolveConfigPath(hermesHome, this.target?.profile ? hermesHome : undefined);
	}

	async install(basePath: string, options: HermesConnectorOptions = {}): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const warnings: string[] = [];
		const expandedBasePath = expandHome(basePath || join(homedir(), ".agents"));
		const strippedAgentsPath = this.target?.profile ? null : this.stripLegacySignetBlock(expandedBasePath);
		if (strippedAgentsPath !== null) {
			filesWritten.push(strippedAgentsPath);
		}

		const hermesHome = this.getHermesHome();
		const hermesRepo = this.getHermesRepo();
		const targetRoot = hermesHome;
		let userPluginInstalled = false;
		let repoPluginInstalled = false;

		// 1. Install the Python plugin into the current user-plugin location.
		try {
			const pluginFiles = installPlugin(getUserPluginTargetDir(hermesHome), "user", targetRoot);
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
				const pluginFiles = installPlugin(getRepoPluginTargetDir(hermesRepo), "repo", hermesRepo);
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

		const envPath = resolveContainedWritePath(join(hermesHome, ".env"), targetRoot);
		let configuredSignetAgentId = "default";
		const configuredDaemonUrl = (process.env.SIGNET_DAEMON_URL?.trim() || "http://127.0.0.1:3850").replace(
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
			// Always write SIGNET_AGENT_ID. Resolution order: explicit env, then
			// the daemon's configured agent (its own SIGNET_AGENT_ID or "default"),
			// then "default" for the default workspace. The harness name
			// ("hermes-agent") is provenance, never an agent id — a stale value
			// from an older install is healed instead of honored.
			let signetAgentId = sanitizedEnv("SIGNET_AGENT_ID");
			if (signetAgentId === "hermes-agent") {
				warnings.push(
					"SIGNET_AGENT_ID='hermes-agent' is the harness name, not an agent scope. Re-resolving from the daemon.",
				);
				signetAgentId = "";
			}
			if (!signetAgentId) {
				signetAgentId = (await resolveDaemonAgentId(configuredDaemonUrl)) || "default";
			}
			configuredSignetAgentId = signetAgentId;
			signetVars.SIGNET_AGENT_ID = signetAgentId;

			const explicitAgentWorkspace = process.env.SIGNET_AGENT_WORKSPACE?.trim();
			if (explicitAgentWorkspace) {
				signetVars.SIGNET_AGENT_WORKSPACE = expandHome(explicitAgentWorkspace).replace(/[\r\n]+/g, "");
			} else if (signetAgentId && signetAgentId !== "default") {
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
				ensureTargetDirectory(hermesHome, targetRoot);
				writeTargetFile(envPath, envContent, targetRoot);
				configsPatched.push(envPath);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(`Failed to update .env: ${msg}`);
		}

		const registrationError = await ensureNamedAgentRegistered(
			configuredDaemonUrl,
			configuredSignetAgentId,
			warnings,
			options,
		);
		if (registrationError) {
			return { success: false, message: registrationError, filesWritten, configsPatched, warnings };
		}

		// 3. Activate Signet as the external Hermes memory provider.
		const providerConfig = configureProvider(hermesHome, warnings, targetRoot);
		if (providerConfig.configPath) {
			configsPatched.push(providerConfig.configPath);
		}
		if (providerConfig.backupPath) {
			filesWritten.push(providerConfig.backupPath);
		}
		if (!isProviderConfigured(hermesHome, targetRoot)) {
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
			const removed = uninstallPlugin(getRepoPluginTargetDir(hermesRepo), "repo", hermesRepo);
			filesRemoved.push(...removed);
		}

		const hermesHome = this.getHermesHome();
		const userPluginTarget = getUserPluginTargetDir(hermesHome);
		const targetRoot = hermesHome;
		const safeUserPluginTarget = resolveContainedWritePath(userPluginTarget, targetRoot);
		const marker = readInstallMarker(safeUserPluginTarget);
		if (!pathEntryExists(safeUserPluginTarget) || marker === null || marker.targetKind !== "user") {
			return { filesRemoved, configsPatched };
		}
		const userPluginRemoved = uninstallPlugin(userPluginTarget, "user", targetRoot);
		filesRemoved.push(...userPluginRemoved);

		const providerConfig = restoreOrClearProvider(hermesHome, targetRoot);
		if (providerConfig.configPath) {
			configsPatched.push(providerConfig.configPath);
		}
		if (providerConfig.backupPath) {
			filesRemoved.push(providerConfig.backupPath);
		}

		const envPath = resolveContainedWritePath(join(hermesHome, ".env"), targetRoot);
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
					writeTargetFile(envPath, `${envContent.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, targetRoot);
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
		const targetRoot = this.target?.profile ? hermesHome : undefined;
		if (!isProviderConfigured(hermesHome, targetRoot)) return false;
		if (hermesRepo) return pluginLooksCurrent(getRepoPluginTargetDir(hermesRepo));
		return pluginLooksCurrent(getUserPluginTargetDir(hermesHome), targetRoot);
	}

	async diagnose(): Promise<HermesDoctorReport> {
		const hermesHome = this.getHermesHome();
		const hermesRepo = this.getHermesRepo();
		return diagnoseHermesIntegration({
			hermesHome,
			hermesRepo,
			targetRoot: this.target?.profile ? hermesHome : undefined,
			daemonUrl: (process.env.SIGNET_DAEMON_URL?.trim() || "http://127.0.0.1:3850").replace(/[\r\n]+/g, ""),
		});
	}
}

export async function diagnoseHermesIntegration(opts?: {
	readonly hermesHome?: string;
	readonly hermesRepo?: string | null;
	readonly targetRoot?: string;
	readonly daemonUrl?: string;
}): Promise<HermesDoctorReport> {
	const hermesHome = opts?.hermesHome ?? resolveHermesHomePath();
	const hermesRepo = opts && "hermesRepo" in opts ? (opts.hermesRepo ?? null) : resolveHermesRepoPath();
	const targetRoot = opts?.targetRoot;
	const daemonUrl = opts?.daemonUrl ?? (process.env.SIGNET_DAEMON_URL?.trim() || "http://127.0.0.1:3850");
	const configPath = resolveConfigPath(hermesHome, targetRoot);
	const userPluginDir = getUserPluginTargetDir(hermesHome);
	const repoPluginDir = hermesRepo ? getRepoPluginTargetDir(hermesRepo) : null;
	const checks: HermesDiagnosticCheck[] = [];
	const warnings: string[] = [];
	let pluginSourceDir: string | null = null;
	let pluginSourceError: string | null = null;
	try {
		pluginSourceDir = getPluginSourceDir();
	} catch (error) {
		pluginSourceError = error instanceof Error ? error.message : String(error);
	}
	const userPluginCurrent = pluginSourceDir !== null && pluginLooksCurrent(userPluginDir, targetRoot);
	const repoPluginCurrent = pluginSourceDir !== null && repoPluginDir ? pluginLooksCurrent(repoPluginDir) : false;
	const probe = hermesRepo
		? probeHermesProvider(hermesRepo)
		: userPluginCurrent
			? { ok: true, toolNames: REQUIRED_TOOL_NAMES, error: null }
			: { ok: false, toolNames: [], error: "Hermes repo not found and user plugin is missing or stale" };
	const daemon = await checkDaemon(daemonUrl);

	checks.push({
		id: "plugin-source",
		label: "Bundled Hermes plugin source",
		ok: pluginSourceDir !== null,
		detail: pluginSourceDir ?? pluginSourceError ?? "Cannot find hermes-plugin directory in connector package",
		fix: pluginSourceDir ? undefined : "Reinstall Signet from a release that includes Hermes connector assets.",
	});
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
		ok: isProviderConfigured(hermesHome, targetRoot),
		detail: existsSync(configPath)
			? `${configPath} ${isProviderConfigured(hermesHome, targetRoot) ? "sets" : "does not set"} memory.provider=signet`
			: `${configPath} does not exist`,
		fix: isProviderConfigured(hermesHome, targetRoot) ? undefined : "Run `signet setup --harness hermes-agent`.",
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
