/**
 * Session notes writer — structured per-session artifact that solves the
 * case-B navigation problem (model has no "open the file I just wrote"
 * affordance for a long session).
 *
 * The notes file is the source of truth for a session's task-level structure:
 * frontmatter with thread_id/agent_id/harness/cwd/branch, one-line outcome,
 * numbered `## Task N` sections with the six required subsections
 * (Outcome / Preference signals / Key steps / Failures and how to do
 * differently / Reusable knowledge / References), and a `<!-- source: ... -->`
 * provenance marker on each section so the file is self-describing.
 *
 * This module is the in-loop writer: the agent can append task sections
 * incrementally, and the file is laid out so future agents (and humans) can
 * read it without inventing structure. The ACPX consolidator that fills
 * missing sections from the transcript lives in PR 3; this module only
 * writes what was given to it.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentsDir } from "@signet/core";
import { redactSecrets } from "./session-checkpoints";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_NOTES_SCHEMA_VERSION = 1 as const;
export const SESSION_NOTES_RELATIVE_DIR = "memory/sessions" as const;
export const SESSION_NOTES_FILENAME = "notes.md" as const;
export const SESSION_NOTES_CONSOLIDATOR_FILENAME = "consolidator.json" as const;

export const REQUIRED_TASK_SECTIONS = [
	"Outcome:",
	"Preference signals:",
	"Key steps:",
	"Failures and how to do differently:",
	"Reusable knowledge:",
	"References:",
] as const;

export type SessionNotesSectionName = (typeof REQUIRED_TASK_SECTIONS)[number];

export const SESSION_NOTES_FEATURE_FLAG = "sessionNotes" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionNotesFrontmatter {
	readonly thread_id: string;
	readonly agent_id: string;
	readonly harness: string;
	readonly cwd: string;
	readonly git_branch: string | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly consolidated: string | null;
	readonly consolidator_model: string | null;
	readonly source_kind: "signet-sessions";
	readonly schema_version: typeof SESSION_NOTES_SCHEMA_VERSION;
}

export interface SessionNotesTaskSection {
	readonly taskIndex: number;
	readonly outcome: string;
	readonly preferenceSignals: readonly string[];
	readonly keySteps: readonly string[];
	readonly failures: readonly string[];
	readonly reusableKnowledge: readonly string[];
	readonly references: readonly string[];
	readonly source: "agent" | "consolidator";
	readonly attributedAt: string;
}

export interface SessionNotesFile {
	readonly frontmatter: SessionNotesFrontmatter;
	readonly summaryLine: string;
	readonly tasks: readonly SessionNotesTaskSection[];
}

export interface AppendTaskSectionParams {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly harness: string;
	readonly cwd: string;
	readonly gitBranch?: string | null;
	readonly task: {
		readonly taskIndex: number;
		readonly outcome: string;
		readonly preferenceSignals?: readonly string[];
		readonly keySteps?: readonly string[];
		readonly failures?: readonly string[];
		readonly reusableKnowledge?: readonly string[];
		readonly references?: readonly string[];
		readonly summaryLine?: string;
	};
	readonly source?: "agent" | "consolidator";
	readonly now?: string;
	readonly agentsDir?: string;
}

export type AppendTaskSectionResult =
	| { readonly ok: true; readonly path: string; readonly task: SessionNotesTaskSection }
	| { readonly ok: false; readonly error: string };

export type ReadSessionNotesResult =
	| { readonly ok: true; readonly file: SessionNotesFile; readonly path: string }
	| { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function sessionNotesDir(sessionKey: string, agentsDir = getAgentsDir()): string {
	return join(agentsDir.replace(/\/$/, ""), SESSION_NOTES_RELATIVE_DIR, sanitizeSessionKey(sessionKey));
}

export function sessionNotesPath(sessionKey: string, agentsDir = getAgentsDir()): string {
	return join(sessionNotesDir(sessionKey, agentsDir), SESSION_NOTES_FILENAME);
}

export function sessionConsolidatorPath(sessionKey: string, agentsDir = getAgentsDir()): string {
	return join(sessionNotesDir(sessionKey, agentsDir), SESSION_NOTES_CONSOLIDATOR_FILENAME);
}

function sanitizeSessionKey(sessionKey: string): string {
	const trimmed = sessionKey.trim();
	if (!trimmed) return "_empty";
	let safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
	// Strip any path-traversal artefacts after the first sweep.
	safe = safe.replace(/\.+/g, ".").replace(/_+/g, "_");
	safe = safe.replace(/^\.+|\.+$/g, "").replace(/^_+|_+$/g, "");
	return safe.length > 0 ? safe.slice(0, 200) : "_empty";
}

function ensureSessionDir(sessionKey: string, agentsDir: string): string {
	const dir = sessionNotesDir(sessionKey, agentsDir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function buildFrontmatter(
	sessionKey: string,
	params: AppendTaskSectionParams,
	now: string,
	consolidated: string | null,
	consolidatorModel: string | null,
): SessionNotesFrontmatter {
	return {
		thread_id: sessionKey,
		agent_id: params.agentId || "default",
		harness: params.harness || "unknown",
		cwd: params.cwd || "",
		git_branch: params.gitBranch ?? null,
		created_at: now,
		updated_at: now,
		consolidated,
		consolidator_model: consolidatorModel,
		source_kind: "signet-sessions",
		schema_version: SESSION_NOTES_SCHEMA_VERSION,
	};
}

function renderFrontmatter(frontmatter: SessionNotesFrontmatter): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value === undefined) {
			lines.push(`${key}:`);
			continue;
		}
		lines.push(`${key}: ${formatYamlScalar(key, value)}`);
	}
	lines.push("---", "");
	return `${lines.join("\n")}\n`;
}

function formatYamlScalar(key: string, value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		if (value === "" || /[:#\n"]/.test(value)) {
			return JSON.stringify(value);
		}
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function parseFrontmatter(raw: string): SessionNotesFrontmatter | null {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return null;
	const body = match[1] ?? "";
	const parsed: Record<string, unknown> = {};
	for (const line of body.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value: string = line.slice(colon + 1).trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				/* leave as-is */
			}
		} else if (value === "null") {
			value = null as unknown as string;
		}
		parsed[key] = value;
	}
	const required = [
		"thread_id",
		"agent_id",
		"harness",
		"cwd",
		"created_at",
		"updated_at",
		"source_kind",
		"schema_version",
	] as const;
	for (const key of required) {
		if (!(key in parsed)) return null;
	}
	if (parsed.source_kind !== "signet-sessions") return null;
	if (Number(parsed.schema_version) !== SESSION_NOTES_SCHEMA_VERSION) return null;
	return {
		thread_id: String(parsed.thread_id),
		agent_id: String(parsed.agent_id),
		harness: String(parsed.harness),
		cwd: String(parsed.cwd),
		git_branch: parsed.git_branch === null || parsed.git_branch === undefined ? null : String(parsed.git_branch),
		created_at: String(parsed.created_at),
		updated_at: String(parsed.updated_at),
		consolidated:
			parsed.consolidated === null || parsed.consolidated === undefined ? null : String(parsed.consolidated),
		consolidator_model:
			parsed.consolidator_model === null || parsed.consolidator_model === undefined
				? null
				: String(parsed.consolidator_model),
		source_kind: "signet-sessions",
		schema_version: SESSION_NOTES_SCHEMA_VERSION,
	};
}

// ---------------------------------------------------------------------------
// Task section rendering
// ---------------------------------------------------------------------------

function renderTaskSection(task: SessionNotesTaskSection): string {
	const out: string[] = [];
	out.push(`## Task ${task.taskIndex}`, "");
	out.push(`<!-- source: ${task.source} | attributed_at: ${task.attributedAt} -->`, "");
	out.push("Outcome:", redactSecrets(task.outcome.trim()), "");
	out.push("Preference signals:");
	if (task.preferenceSignals.length === 0) {
		out.push("- (none captured)", "");
	} else {
		for (const line of task.preferenceSignals) out.push(`- ${redactSecrets(line)}`, "");
	}
	out.push("Key steps:");
	if (task.keySteps.length === 0) {
		out.push("- (none captured)", "");
	} else {
		for (const line of task.keySteps) out.push(`- ${redactSecrets(line)}`, "");
	}
	out.push("Failures and how to do differently:");
	if (task.failures.length === 0) {
		out.push("- (none captured)", "");
	} else {
		for (const line of task.failures) out.push(`- ${redactSecrets(line)}`, "");
	}
	out.push("Reusable knowledge:");
	if (task.reusableKnowledge.length === 0) {
		out.push("- (none captured)", "");
	} else {
		for (const line of task.reusableKnowledge) out.push(`- ${redactSecrets(line)}`, "");
	}
	out.push("References:");
	if (task.references.length === 0) {
		out.push("- (none captured)", "");
	} else {
		for (const line of task.references) out.push(`- ${redactSecrets(line)}`, "");
	}
	out.push("");
	return out.join("\n");
}

function parseTaskSection(heading: string, body: string): SessionNotesTaskSection | null {
	const indexMatch = heading.match(/^##\s+Task\s+(\d+)\s*$/);
	if (!indexMatch) return null;
	const taskIndex = Number(indexMatch[1]);
	const sourceMatch = body.match(/^<!--\s*source:\s*(agent|consolidator)\s*\|\s*attributed_at:\s*([^\s>]+)\s*-->/m);
	const source: "agent" | "consolidator" = sourceMatch ? (sourceMatch[1] as "agent" | "consolidator") : "agent";
	const attributedAt = sourceMatch?.[2] ?? new Date(0).toISOString();

	const blocks = splitBlocks(body);
	const outcome = (blocks["Outcome:"] ?? "").trim();
	const preferenceSignals = parseList(blocks["Preference signals:"]);
	const keySteps = parseList(blocks["Key steps:"]);
	const failures = parseList(blocks["Failures and how to do differently:"]);
	const reusableKnowledge = parseList(blocks["Reusable knowledge:"]);
	const references = parseList(blocks["References:"]);

	return {
		taskIndex,
		outcome,
		preferenceSignals,
		keySteps,
		failures,
		reusableKnowledge,
		references,
		source,
		attributedAt,
	};
}

function splitBlocks(body: string): Record<string, string> {
	const lines = body.split("\n");
	const result: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of lines) {
		if ((REQUIRED_TASK_SECTIONS as readonly string[]).includes(line.trimEnd())) {
			current = line.trimEnd();
			result[current] = [];
		} else if (current) {
			result[current].push(line);
		}
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(result)) out[k] = v.join("\n");
	return out;
}

function parseList(block: string | undefined): string[] {
	if (!block) return [];
	const lines = block.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.replace(/^\s*-\s?/, "").trim();
		if (!trimmed || trimmed === "(none captured)") continue;
		out.push(trimmed);
	}
	return out;
}

// ---------------------------------------------------------------------------
// File IO
// ---------------------------------------------------------------------------

function readNotesFile(path: string): SessionNotesFile | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const frontmatter = parseFrontmatter(raw);
	if (!frontmatter) return null;
	const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const summaryLine = (withoutFrontmatter.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
	const tasks: SessionNotesTaskSection[] = [];
	// Match `## Task N` headings; keep the index in the captured group so we
	// honour non-contiguous task numbers (1, 5, 12) instead of re-synthesizing
	// from the loop counter.
	const headingRe = /^##\s+Task\s+(\d+)\s*$/gm;
	const splits: { index: number; body: string }[] = [];
	let lastEnd = 0;
	let m: RegExpExecArray | null;
	while ((m = headingRe.exec(withoutFrontmatter)) !== null) {
		const before = withoutFrontmatter.slice(lastEnd, m.index);
		if (splits.length > 0) splits[splits.length - 1]!.body = before;
		splits.push({ index: Number(m[1]), body: "" });
		lastEnd = m.index + m[0].length;
	}
	if (splits.length > 0) splits[splits.length - 1]!.body = withoutFrontmatter.slice(lastEnd);
	for (const split of splits) {
		const heading = `## Task ${split.index}`;
		const parsed = parseTaskSection(heading, split.body);
		if (parsed) tasks.push(parsed);
	}
	return { frontmatter, summaryLine, tasks };
}

function writeNotesFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(tmp, content, "utf8");
		renameSync(tmp, path);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* tmp already gone or unreadable; nothing useful to do here */
		}
		throw err;
	}
}

function contentHash(
	frontmatter: SessionNotesFrontmatter,
	summaryLine: string,
	tasks: readonly SessionNotesTaskSection[],
): string {
	const h = createHash("sha256");
	h.update(JSON.stringify(frontmatter));
	h.update("\n");
	h.update(summaryLine);
	h.update("\n");
	for (const task of tasks) h.update(JSON.stringify(task));
	return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single task section to the session notes file. Idempotent: if
 * a task with the same `taskIndex` already exists, it is overwritten in
 * place (preserving order). Secret redaction is applied to all free-text
 * fields via the existing `redactSecrets` helper.
 */
export function appendTaskSection(params: AppendTaskSectionParams): AppendTaskSectionResult {
	if (!params.sessionKey?.trim()) {
		return { ok: false, error: "sessionKey is required" };
	}
	if (!Number.isInteger(params.task.taskIndex) || params.task.taskIndex < 1) {
		return { ok: false, error: "task.taskIndex must be a positive integer" };
	}
	if (typeof params.task.outcome !== "string") {
		return { ok: false, error: "task.outcome must be a string" };
	}
	const now = params.now ?? new Date().toISOString();
	const agentsDir = params.agentsDir ?? getAgentsDir();
	ensureSessionDir(params.sessionKey, agentsDir);
	const path = sessionNotesPath(params.sessionKey, agentsDir);

	const existing = existsSync(path) ? readNotesFile(path) : null;
	const frontmatter: SessionNotesFrontmatter = existing?.frontmatter
		? { ...existing.frontmatter, updated_at: now }
		: buildFrontmatter(params.sessionKey, params, now, null, null);

	const newTask: SessionNotesTaskSection = {
		taskIndex: params.task.taskIndex,
		outcome: params.task.outcome,
		preferenceSignals: (params.task.preferenceSignals ?? []).map((s) => String(s)),
		keySteps: (params.task.keySteps ?? []).map((s) => String(s)),
		failures: (params.task.failures ?? []).map((s) => String(s)),
		reusableKnowledge: (params.task.reusableKnowledge ?? []).map((s) => String(s)),
		references: (params.task.references ?? []).map((s) => String(s)),
		source: params.source ?? "agent",
		attributedAt: now,
	};

	const tasks: SessionNotesTaskSection[] = [];
	for (const t of existing?.tasks ?? []) {
		if (t.taskIndex === newTask.taskIndex) continue;
		tasks.push(t);
	}
	tasks.push(newTask);
	tasks.sort((a, b) => a.taskIndex - b.taskIndex);

	const summaryLine = params.task.summaryLine?.trim() || existing?.summaryLine || deriveSummaryLine(tasks);
	const content = renderNotesFile(frontmatter, summaryLine, tasks);
	writeNotesFileAtomic(path, content);
	return { ok: true, path, task: newTask };
}

function deriveSummaryLine(tasks: readonly SessionNotesTaskSection[]): string {
	if (tasks.length === 0) return "(no tasks recorded)";
	const outcomes = tasks.map((t) => redactSecrets(t.outcome).split(/[.\n]/)[0]?.trim() ?? "").filter(Boolean);
	return outcomes.slice(0, 3).join("; ");
}

function renderNotesFile(
	frontmatter: SessionNotesFrontmatter,
	summaryLine: string,
	tasks: readonly SessionNotesTaskSection[],
): string {
	const out: string[] = [renderFrontmatter(frontmatter), redactSecrets(summaryLine), ""];
	for (const task of tasks) out.push(renderTaskSection(task));
	return out.join("\n");
}

/**
 * Read the structured contents of a session notes file. Returns a
 * discriminated result so callers can branch on missing/empty/invalid
 * without throwing.
 */
export function readSessionNotes(sessionKey: string, agentsDir = getAgentsDir()): ReadSessionNotesResult {
	if (!sessionKey?.trim()) return { ok: false, error: "sessionKey is required" };
	const path = sessionNotesPath(sessionKey, agentsDir);
	if (!existsSync(path)) return { ok: false, error: `Session notes not found: ${path}` };
	const file = readNotesFile(path);
	if (!file) return { ok: false, error: `Session notes file is not parseable: ${path}` };
	return { ok: true, file, path };
}

/**
 * Hash the file's parsed contents. Used by the consolidator and tests to
 * detect "did anything actually change" without diffing markdown.
 */
export function sessionNotesFingerprint(file: SessionNotesFile): string {
	return contentHash(file.frontmatter, file.summaryLine, file.tasks);
}
