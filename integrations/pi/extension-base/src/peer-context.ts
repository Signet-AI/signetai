import { hostname as osHostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { redactCredentials } from "@signet/core";

export const PEER_TASK_MAX = 400;
export const PEER_TITLE_MAX = 160;
export const PEER_PATH_MAX = 300;
export const PEER_MODIFIED_FILES_MAX = 20;
export const PEER_CWD_MAX = 512;
export const PEER_HOST_MAX = 128;
export const PEER_RESOURCE_MAX = 160;
export const PEER_RESOURCES_MAX = 20;

export interface PeerContext {
	cwd?: string;
	hostname?: string;
	title?: string;
	task?: string;
	modifiedFiles?: string[];
	resources?: string[];
}

export interface PeerContextBase {
	readonly cwd?: string;
	readonly title?: string;
}

const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch"]);

function clip(value: string, max: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? text.slice(0, max) : text;
}

export function boundTask(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = clip(redactCredentials(value), PEER_TASK_MAX);
	return text || undefined;
}

export function boundResources(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const text = clip(item, PEER_RESOURCE_MAX);
		if (text && !out.includes(text)) out.push(text);
		if (out.length >= PEER_RESOURCES_MAX) break;
	}
	return out;
}

function patchPaths(input: Record<string, unknown>): string[] {
	const text = [input.patch, input.input, input.patchText, input.diff].find((v) => typeof v === "string");
	if (typeof text !== "string") return [];
	const paths: string[] = [];
	for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
		if (match[1]) paths.push(match[1].trim());
	}
	return paths;
}

export function mutatedPaths(toolName: string, input: unknown): string[] {
	if (!MUTATING_TOOLS.has(toolName.toLowerCase())) return [];
	if (typeof input !== "object" || input === null) return [];
	const record = input as Record<string, unknown>;
	const direct = [record.file_path, record.path, record.filePath].find((v) => typeof v === "string" && v.trim());
	if (typeof direct === "string") return [direct.trim()];
	return patchPaths(record);
}

interface SessionTrack {
	task?: string;
	resources?: string[];
	modified: string[];
}

export class PeerContextTracker {
	private readonly sessions = new Map<string, SessionTrack>();

	private track(sessionId: string): SessionTrack {
		let entry = this.sessions.get(sessionId);
		if (!entry) {
			entry = { modified: [] };
			this.sessions.set(sessionId, entry);
		}
		return entry;
	}

	setTask(sessionId: string, task: string | undefined): void {
		this.track(sessionId).task = task;
	}

	setResources(sessionId: string, resources: string[]): void {
		this.track(sessionId).resources = resources;
	}

	recordMutation(sessionId: string, toolName: string, input: unknown, cwd: string | undefined): boolean {
		const paths = mutatedPaths(toolName, input);
		if (paths.length === 0) return false;
		const entry = this.track(sessionId);
		let changed = false;
		for (const raw of paths) {
			const full = cwd && !isAbsolute(raw) ? resolve(cwd, raw) : raw;
			if (full.length > PEER_PATH_MAX) continue;
			entry.modified = entry.modified.filter((p) => p !== full);
			entry.modified.push(full);
			changed = true;
		}
		if (entry.modified.length > PEER_MODIFIED_FILES_MAX) {
			entry.modified = entry.modified.slice(-PEER_MODIFIED_FILES_MAX);
		}
		return changed;
	}

	snapshot(sessionId: string | undefined, base: PeerContextBase): PeerContext | undefined {
		const context: PeerContext = {};
		if (base.cwd && base.cwd.length <= PEER_CWD_MAX) context.cwd = base.cwd;
		const host = osHostname();
		if (host && host.length <= PEER_HOST_MAX) context.hostname = host;
		const title = base.title ? clip(base.title, PEER_TITLE_MAX) : "";
		if (title) context.title = title;
		const entry = sessionId ? this.sessions.get(sessionId) : undefined;
		if (entry?.task) context.task = entry.task;
		if (entry && entry.modified.length > 0) context.modifiedFiles = [...entry.modified];
		if (entry?.resources) context.resources = [...entry.resources];
		return Object.keys(context).length > 0 ? context : undefined;
	}

	forget(sessionId: string | undefined): void {
		if (sessionId) this.sessions.delete(sessionId);
	}
}
