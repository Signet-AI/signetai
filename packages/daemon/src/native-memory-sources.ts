import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { watch } from "chokidar";
import { resolveDaemonAgentId } from "./agent-id";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { deleteArtifactRowsForPath, indexExternalMemoryArtifact } from "./memory-lineage";

export interface NativeMemorySource {
	readonly harness: string;
	readonly displayName: string;
	readonly root: string;
	readonly files: readonly NativeMemoryFilePattern[];
}

export interface NativeMemoryFilePattern {
	readonly glob: string;
	readonly kind: string;
	readonly include?: (path: string) => boolean;
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

function codexMemoryRoot(): string {
	return join(homedir(), ".codex", "memories");
}

export function codexNativeMemorySource(root = codexMemoryRoot()): NativeMemorySource {
	return {
		harness: "codex",
		displayName: "Codex",
		root,
		files: [
			{ glob: "memory_summary.md", kind: "native_memory_summary" },
			{ glob: "MEMORY.md", kind: "native_memory_registry" },
			{ glob: "raw_memories.md", kind: "native_raw_memories" },
			{
				glob: "rollout_summaries/*.md",
				kind: "native_rollout_summary",
				include: (path) => path.replace(/\\/g, "/").includes("/rollout_summaries/"),
			},
		],
	};
}

function walkMarkdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkMarkdownFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			out.push(path);
		}
	}
	return out.sort();
}

function matchesPattern(source: NativeMemorySource, filePath: string): NativeMemoryFilePattern | null {
	const normalized = filePath.replace(/\\/g, "/");
	const root = source.root.replace(/\\/g, "/").replace(/\/$/, "");
	const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	for (const pattern of source.files) {
		if (pattern.include && !pattern.include(normalized)) continue;
		if (pattern.glob === rel) return pattern;
		if (pattern.glob.endsWith("/*.md")) {
			const prefix = pattern.glob.slice(0, -"*.md".length);
			if (rel.startsWith(prefix) && basename(rel).endsWith(".md")) return pattern;
		}
	}
	return null;
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
				.prepare("SELECT 1 FROM memory_artifacts WHERE agent_id = ? AND source_path = ? LIMIT 1")
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
	deleteArtifactRowsForPath(filePath, agentId);
}

export function startNativeMemoryBridge(
	sources: readonly NativeMemorySource[] = [codexNativeMemorySource()],
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
		for (const source of sources) {
			if (!existsSync(source.root)) continue;
			for (const file of walkMarkdownFiles(source.root)) {
				if (await indexNativeMemoryFile(source, file, agentId)) count++;
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
