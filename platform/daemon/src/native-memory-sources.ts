import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { watch } from "chokidar";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { indexExternalMemoryArtifact, softDeleteArtifactRowsForPath } from "./memory-lineage";

export interface NativeMemorySource {
	readonly harness: string;
	readonly displayName: string;
	readonly root: string;
	readonly files: readonly NativeMemoryFilePattern[];
}

export interface NativeMemoryFilePattern {
	readonly glob: string;
	readonly kind: string;
	readonly include?: (path: string, rel: string) => boolean;
}

export interface NativeMemoryBridgeHandle {
	readonly syncExisting: () => Promise<number>;
	readonly close: () => Promise<void>;
}

export interface NativeMemoryBridgeOptions {
	readonly agentId?: string;
	readonly pollIntervalMs?: number;
}

const indexed = new Map<string, string>();

function codexRoot(): string {
	return join(homedir(), ".codex");
}

function claudeCodeRoot(): string {
	return join(homedir(), ".claude");
}

export function codexNativeMemorySource(root = codexRoot()): NativeMemorySource {
	return {
		harness: "codex",
		displayName: "Codex",
		root,
		files: [
			{ glob: "memories/memory_summary.md", kind: "native_memory_summary" },
			{ glob: "memories/MEMORY.md", kind: "native_memory_registry" },
			{ glob: "memories/raw_memories.md", kind: "native_raw_memories" },
			{ glob: "memories/rollout_summaries/*.md", kind: "native_rollout_summary" },
			{ glob: "automations/*/memory.md", kind: "native_automation_memory" },
		],
	};
}

export function claudeCodeNativeMemorySource(root = claudeCodeRoot()): NativeMemorySource {
	return {
		harness: "claude-code",
		displayName: "Claude Code",
		root,
		files: [
			{ glob: "projects/*/memory/MEMORY.md", kind: "native_claude_memory_index" },
			{
				glob: "projects/*/memory/**/*.md",
				kind: "native_claude_memory",
				include: (path) => basename(path) !== "MEMORY.md",
			},
			{ glob: "session-memory/**/*.md", kind: "native_claude_session_memory" },
			{ glob: "agent-memory/*/*.md", kind: "native_claude_agent_memory" },
			{ glob: "agent-memory-local/*/*.md", kind: "native_claude_agent_memory_local" },
		],
	};
}

async function* walkMarkdownFiles(dir: string): AsyncGenerator<string> {
	if (!existsSync(dir)) return;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkMarkdownFiles(path);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			yield path;
		}
	}
}

function matchesPattern(source: NativeMemorySource, filePath: string): NativeMemoryFilePattern | null {
	const normalized = filePath.replace(/\\/g, "/");
	const root = source.root.replace(/\\/g, "/").replace(/\/$/, "");
	const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	for (const pattern of source.files) {
		if (pattern.include && !pattern.include(normalized, rel)) continue;
		if (matchesGlob(pattern.glob, rel)) return pattern;
	}
	return null;
}

function matchesGlob(glob: string, rel: string): boolean {
	return matchGlobParts(glob.split("/"), rel.split("/"));
}

function matchGlobParts(globParts: readonly string[], relParts: readonly string[]): boolean {
	if (globParts.length === 0) return relParts.length === 0;
	const [globHead, ...globTail] = globParts;
	if (globHead === "**") {
		return matchGlobParts(globTail, relParts) || (relParts.length > 0 && matchGlobParts(globParts, relParts.slice(1)));
	}
	if (relParts.length === 0) return false;
	return matchesGlobSegment(globHead ?? "", relParts[0] ?? "") && matchGlobParts(globTail, relParts.slice(1));
}

function matchesGlobSegment(glob: string, value: string): boolean {
	if (glob === "*") return value.length > 0;
	if (!glob.includes("*")) return glob === value;
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const pattern = `^${escaped.replace(/\*/g, ".*")}$`;
	return new RegExp(pattern).test(value);
}

function resolveBridgeAgentId(agentId?: string): string {
	const trimmed = agentId?.trim();
	return trimmed ? trimmed : resolveDaemonAgentId();
}

function fingerprintKey(source: NativeMemorySource, filePath: string, agentId: string): string {
	return `${agentId}:${source.harness}:${filePath}`;
}

function nativeArtifactRowExists(filePath: string, agentId: string): boolean {
	const sourcePath = filePath.replace(/\\/g, "/");
	try {
		return getDbAccessor().withReadDb((db) => {
			const row = db
				.prepare(
					"SELECT 1 FROM memory_artifacts WHERE agent_id = ? AND source_path = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1",
				)
				.get(agentId, sourcePath);
			return !!row;
		});
	} catch {
		return false;
	}
}

export async function indexNativeMemoryFile(
	source: NativeMemorySource,
	filePath: string,
	agentId = resolveDaemonAgentId(),
): Promise<boolean> {
	const pattern = matchesPattern(source, filePath);
	if (!pattern) return false;

	let content = "";
	let mtimeMs = 0;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) return false;
		mtimeMs = stat.mtimeMs;
		content = readFileSync(filePath, "utf-8");
	} catch (err) {
		logger.warn("watcher", "Failed reading native memory artifact", {
			harness: source.harness,
			path: filePath,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
	if (!content.trim()) return false;

	const key = fingerprintKey(source, filePath, agentId);
	const fingerprint = `${mtimeMs}:${createHash("sha256").update(content).digest("hex")}`;
	if (indexed.get(key) === fingerprint) {
		if (nativeArtifactRowExists(filePath, agentId)) return false;
		indexed.delete(key);
	}

	try {
		indexExternalMemoryArtifact({
			agentId,
			sourcePath: filePath,
			sourceKind: pattern.kind,
			harness: source.harness,
			content,
			sourceMtimeMs: mtimeMs,
		});
		indexed.set(key, fingerprint);
		logger.info("watcher", "Indexed native memory artifact", {
			harness: source.harness,
			kind: pattern.kind,
			path: filePath,
		});
		return true;
	} catch (err) {
		logger.warn("watcher", "Failed indexing native memory artifact", {
			harness: source.harness,
			path: filePath,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

export function removeNativeMemoryFile(
	source: NativeMemorySource,
	filePath: string,
	agentId = resolveDaemonAgentId(),
): void {
	indexed.delete(fingerprintKey(source, filePath, agentId));
	softDeleteArtifactRowsForPath(filePath, agentId);
}

export function startNativeMemoryBridge(
	sources: readonly NativeMemorySource[] = [codexNativeMemorySource(), claudeCodeNativeMemorySource()],
	options: NativeMemoryBridgeOptions = {},
): NativeMemoryBridgeHandle {
	const agentId = resolveBridgeAgentId(options.agentId);
	const watchers = sources.map((source) => {
		const patterns = source.files.map((file) => join(source.root, file.glob));
		const watcher = watch(patterns, {
			ignoreInitial: true,
			persistent: true,
		});
		watcher.on("add", (path) => void indexNativeMemoryFile(source, path, agentId));
		watcher.on("change", (path) => void indexNativeMemoryFile(source, path, agentId));
		watcher.on("unlink", (path) => {
			try {
				removeNativeMemoryFile(source, path, agentId);
			} catch (err) {
				logger.warn("watcher", "Failed removing native memory artifact index row", {
					harness: source.harness,
					path,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});
		return { source, watcher };
	});

	const syncExisting = async (): Promise<number> => {
		let count = 0;
		const yielder = yieldEvery(20);
		for (const source of sources) {
			if (!existsSync(source.root)) continue;
			for await (const file of walkMarkdownFiles(source.root)) {
				if (await indexNativeMemoryFile(source, file, agentId)) count++;
				await yielder();
			}
		}
		return count;
	};
	let polling = false;
	const pollIntervalMs = options.pollIntervalMs ?? 10_000;
	const pollTimer =
		pollIntervalMs > 0
			? setInterval(() => {
					if (polling) return;
					polling = true;
					syncExisting()
						.catch((err) => {
							logger.warn("watcher", "Failed polling native memory sources", {
								error: err instanceof Error ? err.message : String(err),
							});
						})
						.finally(() => {
							polling = false;
						});
				}, pollIntervalMs)
			: null;
	pollTimer?.unref?.();

	return {
		syncExisting,
		async close(): Promise<void> {
			if (pollTimer) clearInterval(pollTimer);
			await Promise.all(watchers.map(({ watcher }) => watcher.close()));
		},
	};
}
