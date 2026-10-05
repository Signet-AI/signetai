import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const repoRoot = resolve(import.meta.dir, "../../../..");
export const skillRoot = resolve(import.meta.dir, "..");
export const runsDir = join(repoRoot, "memorybench", "data", "runs");
export const ledgerPath = join(skillRoot, "results", "ledger.jsonl");

export interface CheckpointQuestion {
	readonly questionId: string;
	readonly containerTag: string;
	readonly question: string;
	readonly groundTruth?: unknown;
	readonly questionDate?: string;
}

export interface Checkpoint {
	readonly runId: string;
	readonly benchmark: string;
	readonly provider: string;
	readonly judge: string;
	readonly answeringModel: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly status: string;
	readonly questions: Record<string, CheckpointQuestion>;
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readCheckpoint(runId: string): Checkpoint {
	const path = join(runsDir, runId, "checkpoint.json");
	if (!existsSync(path)) throw new Error(`No checkpoint for run ${runId} at ${path}`);
	return readJson<Checkpoint>(path);
}

export function scopeAgentIds(checkpoint: Checkpoint): string[] {
	return Object.values(checkpoint.questions).map((question) => `memorybench-${question.containerTag}`);
}

export function workspaceDbPath(workspace: string): string {
	const path = join(workspace, "agents", "data", "signet.db");
	if (!existsSync(path)) throw new Error(`No workspace database at ${path}`);
	return path;
}

export function openReadOnly(workspace: string): Database {
	return new Database(workspaceDbPath(workspace), { readonly: true });
}

export interface DreamingSetup {
	readonly executor: string | null;
	readonly model: string | null;
	readonly codemode: boolean | null;
	readonly maxConcurrentPasses: number | null;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function readDreamingSetup(workspace: string): DreamingSetup {
	const path = join(workspace, "agents", "agent.yaml");
	if (!existsSync(path)) return { executor: null, model: null, codemode: null, maxConcurrentPasses: null };
	const config = record(parseYaml(readFileSync(path, "utf8")));
	const inference = record(config.inference);
	const policy = typeof inference.defaultPolicy === "string" ? inference.defaultPolicy : "background";
	const target = record(record(inference.targets)[policy]);
	const model = record(record(target.models).default).model;
	const dreaming = record(record(config.memory).dreaming);
	return {
		executor: typeof target.executor === "string" ? target.executor : null,
		model: typeof model === "string" ? model : null,
		codemode: typeof dreaming.codemode === "boolean" ? dreaming.codemode : false,
		maxConcurrentPasses: typeof dreaming.maxConcurrentPasses === "number" ? dreaming.maxConcurrentPasses : null,
	};
}

export function argValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

export function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}
