import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { loadMemoryConfig } from "./memory-config";
import { resolvePredictorCheckpointPath } from "./predictor-client";

function normalizePath(path: string): string {
	return normalize(path);
}

function resolveForComparison(path: string): string {
	return normalizePath(isAbsolute(path) ? path : resolve(path));
}

function relativePathWithin(root: string, target: string): string | null {
	const rel = normalizePath(relative(root, target));
	if (rel === "" || rel === ".") return "";
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

export function createAgentsWatcherIgnoreMatcher(agentsDir: string): (path: string) => boolean {
	const defaultPredictorCheckpoint = normalizePath(join(agentsDir, "memory", "predictor", "model.bin"));
	const configuredPredictorCheckpoint = resolveForComparison(
		resolvePredictorCheckpointPath(loadMemoryConfig(agentsDir).pipelineV2.predictor),
	);
	const agentRoot = resolveForComparison(join(agentsDir, "agents"));
	const memoriesDb = resolveForComparison(join(agentsDir, "memory", "memories.db"));
	const memoriesDbWal = resolveForComparison(join(agentsDir, "memory", "memories.db-wal"));
	const memoriesDbShm = resolveForComparison(join(agentsDir, "memory", "memories.db-shm"));
	const memoriesDbJournal = resolveForComparison(join(agentsDir, "memory", "memories.db-journal"));
	const ignoredPaths = new Set([
		defaultPredictorCheckpoint,
		configuredPredictorCheckpoint,
		memoriesDb,
		memoriesDbWal,
		memoriesDbShm,
		memoriesDbJournal,
	]);

	return (path: string): boolean => {
		const normalizedPath = resolveForComparison(path);
		const relativeToAgentsRoot = relativePathWithin(agentRoot, normalizedPath);
		const agentSegments = relativeToAgentsRoot === null ? [] : relativeToAgentsRoot.split(/[\\/]+/).filter(Boolean);
		const isGeneratedWorkspacePath =
			agentSegments.length === 3 && agentSegments[1] === "workspace" && agentSegments[2] === "AGENTS.md";
		return isGeneratedWorkspacePath || ignoredPaths.has(normalizedPath);
	};
}
