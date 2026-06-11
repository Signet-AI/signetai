import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { detectExistingSetup } from "@signet/core";
import {
	type WorkspaceResolution,
	normalizeWorkspacePath,
	resolveAgentsDir,
	writeConfiguredWorkspacePath,
} from "../lib/workspace.js";

export interface WorkspaceCandidate {
	readonly path: string;
	readonly source: "detected" | "preset";
	readonly score: number;
}

export interface WorkspaceSetOptions {
	readonly currentPath?: string;
	readonly force?: boolean;
	readonly patchOpenClaw?: boolean;
	readonly env?: NodeJS.ProcessEnv;
}

export interface WorkspaceSetResult {
	readonly previousPath: string;
	readonly nextPath: string;
	readonly changed: boolean;
	readonly migrated: boolean;
	readonly copiedFiles: number;
	readonly overwrittenFiles: number;
	readonly patchedConfigs: readonly string[];
	readonly configPath: string;
}

interface CopyPlan {
	readonly dirs: string[];
	readonly adds: Array<{ src: string; dst: string }>;
	readonly overwrites: Array<{ src: string; dst: string }>;
	readonly conflicts: string[];
}

const VERIFY_FILES = [
	"agent.yaml",
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"MEMORY.md",
	join("memory", "memories.db"),
] as const;

const WORKSPACE_PRESETS = [
	join("~", ".openclaw", "workspace"),
	join("~", ".clawdbot", "workspace"),
	join("~", "clawd"),
	join("~", ".moltbot", "workspace"),
] as const;

const SKIP_PATHS = new Set([".daemon/pid"]);
const SKIP_DIRS = new Set([".daemon/logs"]);

export function getWorkspaceStatus(env: NodeJS.ProcessEnv = process.env): WorkspaceResolution {
	return resolveAgentsDir(env);
}

export function listWorkspaceCandidates(currentPath: string): WorkspaceCandidate[] {
	const current = normalizeWorkspacePath(currentPath);
	const seen = new Set<string>([current]);
	const out: WorkspaceCandidate[] = [];

	const discovered = new OpenClawConnector().getDiscoveredWorkspacePaths();
	for (const raw of discovered) {
		const path = normalizeWorkspacePath(raw);
		if (seen.has(path)) {
			continue;
		}
		seen.add(path);
		out.push({
			path,
			source: "detected",
			score: scoreWorkspace(path),
		});
	}

	for (const raw of WORKSPACE_PRESETS) {
		const path = normalizeWorkspacePath(raw);
		if (seen.has(path)) {
			continue;
		}
		seen.add(path);
		out.push({
			path,
			source: "preset",
			score: scoreWorkspace(path),
		});
	}

	return out.sort((a, b) => b.score - a.score);
}

export function chooseWorkspaceCandidate(currentPath: string): string {
	const ranked = listWorkspaceCandidates(currentPath);
	if (ranked.length === 0) {
		return normalizeWorkspacePath(currentPath);
	}

	return ranked[0].path;
}

export async function setWorkspacePath(pathValue: string, opts: WorkspaceSetOptions = {}): Promise<WorkspaceSetResult> {
	const prev = opts.currentPath ? normalizeWorkspacePath(opts.currentPath) : resolveAgentsDir(opts.env).path;
	const next = normalizeWorkspacePath(pathValue);
	if (prev !== next && pathsOverlap(prev, next)) {
		throw new Error("workspace migration path overlap is not allowed");
	}
	mkdirSync(next, { recursive: true });

	const plan = existsSync(prev) && prev !== next ? buildCopyPlan(prev, next, opts.force === true) : emptyPlan();
	if (plan.conflicts.length > 0) {
		const sample = plan.conflicts.slice(0, 5).join("\n  - ");
		const more = plan.conflicts.length > 5 ? `\n  ... and ${plan.conflicts.length - 5} more` : "";
		throw new Error(`workspace migration has conflicts:\n  - ${sample}${more}`);
	}

	applyCopyPlan(plan);
	if (plan.adds.length + plan.overwrites.length > 0) {
		verifyCoreFiles(prev, next);
	}

	const patch = opts.patchOpenClaw === false ? [] : await new OpenClawConnector().configureWorkspace(next);
	const cfgPath = writeConfiguredWorkspacePath(next, opts.env);

	return {
		previousPath: prev,
		nextPath: next,
		changed: prev !== next,
		migrated: plan.adds.length + plan.overwrites.length > 0,
		copiedFiles: plan.adds.length,
		overwrittenFiles: plan.overwrites.length,
		patchedConfigs: patch,
		configPath: cfgPath,
	};
}

function emptyPlan(): CopyPlan {
	return {
		dirs: [],
		adds: [],
		overwrites: [],
		conflicts: [],
	};
}

function scoreWorkspace(path: string): number {
	const setup = detectExistingSetup(path);
	let score = 0;
	if (setup.memoryDb) score += 100;
	if (setup.agentYaml) score += 60;
	if (setup.identityFiles.length > 0) score += 40;
	if (setup.agentsDir) score += 10;
	return score;
}

function buildCopyPlan(srcRoot: string, dstRoot: string, force: boolean): CopyPlan {
	const plan = emptyPlan();
	scanDir(srcRoot, dstRoot, "", plan, force);
	return plan;
}

function scanDir(srcDir: string, dstDir: string, rel: string, plan: CopyPlan, force: boolean): void {
	const srcStat = lstatSync(srcDir);
	if (!srcStat.isDirectory()) {
		plan.conflicts.push(`${srcDir} is not a directory`);
		return;
	}

	if (!existsSync(dstDir)) {
		plan.dirs.push(dstDir);
	}

	if (existsSync(dstDir)) {
		const dstStat = lstatSync(dstDir);
		if (!dstStat.isDirectory()) {
			plan.conflicts.push(`${dstDir} exists and is not a directory`);
			return;
		}
	}

	const entries = readdirSync(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		const src = join(srcDir, entry.name);
		const dst = join(dstDir, entry.name);
		const nextRel = rel.length === 0 ? entry.name : join(rel, entry.name);
		if (entry.isSymbolicLink()) {
			continue;
		}
		if (shouldSkip(nextRel, entry.isDirectory())) {
			continue;
		}
		if (entry.isDirectory()) {
			scanDir(src, dst, nextRel, plan, force);
			continue;
		}

		if (!entry.isFile()) {
			plan.conflicts.push(`${src} is not a regular file`);
			continue;
		}

		classifyFile(src, dst, plan, force);
	}
}

function classifyFile(src: string, dst: string, plan: CopyPlan, force: boolean): void {
	if (!existsSync(dst)) {
		plan.adds.push({ src, dst });
		return;
	}

	const dstStat = lstatSync(dst);
	if (!dstStat.isFile()) {
		plan.conflicts.push(`${dst} exists and is not a regular file`);
		return;
	}

	if (filesEqual(src, dst)) {
		return;
	}

	if (force) {
		plan.overwrites.push({ src, dst });
		return;
	}

	plan.conflicts.push(`${dst} already exists with different content`);
}

function applyCopyPlan(plan: CopyPlan): void {
	const dirs = [...new Set(plan.dirs)].sort((a, b) => a.length - b.length);
	for (const dir of dirs) {
		mkdirSync(dir, { recursive: true });
	}

	for (const file of plan.adds) {
		mkdirSync(dirname(file.dst), { recursive: true });
		copyFileSync(file.src, file.dst);
	}

	for (const file of plan.overwrites) {
		mkdirSync(dirname(file.dst), { recursive: true });
		copyFileSync(file.src, file.dst);
	}
}

function verifyCoreFiles(srcRoot: string, dstRoot: string): void {
	for (const rel of VERIFY_FILES) {
		const src = join(srcRoot, rel);
		if (!existsSync(src)) {
			continue;
		}

		const dst = join(dstRoot, rel);
		if (!existsSync(dst)) {
			throw new Error(`verification failed: ${rel} missing in destination`);
		}

		if (!filesEqual(src, dst)) {
			throw new Error(`verification failed: ${rel} differs after copy`);
		}
	}
}

function filesEqual(a: string, b: string): boolean {
	const aStat = lstatSync(a);
	const bStat = lstatSync(b);
	if (!aStat.isFile() || !bStat.isFile()) {
		return false;
	}

	if (aStat.size !== bStat.size) {
		return false;
	}

	const aHash = hashFile(a);
	const bHash = hashFile(b);
	return aHash === bHash;
}

function hashFile(path: string): string {
	const fd = openSync(path, "r");
	const hash = createHash("sha256");
	const chunk = Buffer.allocUnsafe(1024 * 1024);
	try {
		while (true) {
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) {
				break;
			}
			hash.update(chunk.subarray(0, n));
		}
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

function shouldSkip(rel: string, isDir: boolean): boolean {
	const key = rel.replace(/\\/g, "/");
	if (SKIP_PATHS.has(key)) {
		return true;
	}

	if (isDir && SKIP_DIRS.has(key)) {
		return true;
	}

	return false;
}

function pathsOverlap(a: string, b: string): boolean {
	const aRoot = a.endsWith(sep) ? a : `${a}${sep}`;
	const bRoot = b.endsWith(sep) ? b : `${b}${sep}`;
	if (b.startsWith(aRoot)) {
		return true;
	}

	return a.startsWith(bRoot);
}
