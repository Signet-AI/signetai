/**
 * Session notes consolidator — LLM-backed end-of-session pass that
 * fills the lowest-missing `## Task N` section in the session notes
 * file from the canonical transcript. The agent can pre-write
 * sections during the session; whatever it didn't write, the
 * consolidator derives from the transcript and the configured LLM
 * (the same provider the daemon uses for memory extraction).
 *
 * Graceful-degradation contract (mirrors the Codex
 * `automation-run-memory-phase-2-consolidation.md` pattern):
 *   - if the provider is null, the consolidator logs and returns
 *   - if the model output is malformed, the consolidator logs and
 *     returns without overwriting good sections
 *   - if the notes file is missing, the consolidator returns
 *
 * Sections written by the consolidator carry
 * `<!-- source: consolidator -->` so the provenance is durable
 * in the file itself, not just in the database.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentsDir } from "@signet/core";
import { logger } from "./logger";
import type { LlmProvider } from "./pipeline/provider";
import { redactSecrets } from "./session-checkpoints";
import {
	SESSION_NOTES_FILENAME,
	appendTaskSection,
	findLowestMissingIndex,
	isNotesFileFresh,
	parseTaskSectionBody,
	readSessionNotes,
	sessionNotesDir,
	sessionNotesFingerprint,
} from "./session-notes-writer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsolidatorInput {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly harness: string;
	readonly cwd: string;
	readonly transcript: string;
	readonly now?: string;
	readonly agentsDir?: string;
	/** Pre-built LLM provider (e.g. from the inference router). If null, the
	 *  consolidator is a no-op. */
	readonly provider: LlmProvider | null;
	/** Provider model name, recorded in the consolidator artifact. */
	readonly providerModel: string | null;
}

export interface ConsolidatorOutput {
	readonly ran: boolean;
	readonly reason?: "no-file" | "no-transcript" | "complete" | "no-provider" | "no-missing-tasks" | "error";
	readonly tasksFilled: number;
	readonly model: string | null;
	readonly error?: string;
}

export interface ConsolidatorArtifact {
	readonly sessionKey: string;
	readonly ranAt: string;
	readonly model: string | null;
	readonly tasksFilled: number;
	readonly status: "ok" | "skipped" | "error";
	readonly error?: string;
}

const CONSOLIDATOR_MAX_TRANSCRIPT_CHARS = 60_000;
const CONSOLIDATOR_TIMEOUT_MS = 60_000;
/**
 * A notes file last touched within this window is considered fresh — the
 * agent has just finished writing and there is no missing task to fill.
 * The consolidator skips such files to avoid fabricating phantom tasks.
 */
const CONSOLIDATOR_FRESH_WINDOW_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the consolidator pass for one session. Writes the
 * consolidator attribution JSON alongside notes.md so the file
 * carries its own provenance trail.
 */
export async function consolidateSession(input: ConsolidatorInput): Promise<ConsolidatorOutput> {
	const agentsDir = input.agentsDir ?? getAgentsDir();

	const read = readSessionNotes(input.sessionKey, agentsDir);
	if (!read.ok) {
		logger.info("session-notes-consolidator", "No notes file to consolidate", {
			sessionKey: input.sessionKey,
			error: read.error,
		});
		await writeArtifact(agentsDir, input.sessionKey, {
			sessionKey: input.sessionKey,
			ranAt: input.now ?? new Date().toISOString(),
			model: input.providerModel,
			tasksFilled: 0,
			status: "skipped",
			error: read.error,
		});
		return { ran: false, reason: "no-file", tasksFilled: 0, model: input.providerModel };
	}

	if (!input.transcript || input.transcript.trim().length === 0) {
		logger.info("session-notes-consolidator", "No transcript to consolidate from", {
			sessionKey: input.sessionKey,
		});
		await writeArtifact(agentsDir, input.sessionKey, {
			sessionKey: input.sessionKey,
			ranAt: input.now ?? new Date().toISOString(),
			model: input.providerModel,
			tasksFilled: 0,
			status: "skipped",
			error: "empty transcript",
		});
		return { ran: false, reason: "no-transcript", tasksFilled: 0, model: input.providerModel };
	}

	if (!input.provider) {
		logger.info("session-notes-consolidator", "Provider not configured, skipping", {
			sessionKey: input.sessionKey,
		});
		await writeArtifact(agentsDir, input.sessionKey, {
			sessionKey: input.sessionKey,
			ranAt: input.now ?? new Date().toISOString(),
			model: input.providerModel,
			tasksFilled: 0,
			status: "skipped",
			error: "provider not configured",
		});
		return { ran: false, reason: "no-provider", tasksFilled: 0, model: input.providerModel };
	}

	const existingIndices = read.file.tasks.map((t) => t.taskIndex);
	const targetIndex = findLowestMissingIndex(existingIndices);
	// Skip fresh-and-complete files: a session that just wrote all its
	// sections has nothing to consolidate, and firing a model call would
	// invent a phantom task the agent never asked for.
	if (existingIndices.length > 0) {
		const now = input.now ? new Date(input.now) : new Date();
		if (isNotesFileFresh(read.file.frontmatter, now, CONSOLIDATOR_FRESH_WINDOW_MS)) {
			logger.info("session-notes-consolidator", "Notes file is fresh, skipping", {
				sessionKey: input.sessionKey,
				updatedAt: read.file.frontmatter.updated_at,
				taskCount: read.file.tasks.length,
			});
			return { ran: false, reason: "no-missing-tasks", tasksFilled: 0, model: input.providerModel };
		}
	}

	const beforeFingerprint = sessionNotesFingerprint(read.file);
	const transcriptSnippet = redactSecrets(
		input.transcript.length > CONSOLIDATOR_MAX_TRANSCRIPT_CHARS
			? `${input.transcript.slice(0, CONSOLIDATOR_MAX_TRANSCRIPT_CHARS)}\n[truncated]`
			: input.transcript,
	);

	const prompt = buildConsolidatorPrompt(targetIndex, redactSecrets(read.file.summaryLine), transcriptSnippet);
	let modelOutput: string;
	try {
		modelOutput = await input.provider.generate(prompt, { timeoutMs: CONSOLIDATOR_TIMEOUT_MS });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logger.warn("session-notes-consolidator", "Provider generation failed", {
			sessionKey: input.sessionKey,
			error: detail,
		});
		await writeArtifact(agentsDir, input.sessionKey, {
			sessionKey: input.sessionKey,
			ranAt: input.now ?? new Date().toISOString(),
			model: input.providerModel,
			tasksFilled: 0,
			status: "error",
			error: detail,
		});
		return { ran: false, reason: "error", tasksFilled: 0, model: input.providerModel, error: detail };
	}

	const body = extractTaskBody(modelOutput, targetIndex);
	if (!body) {
		logger.warn("session-notes-consolidator", "Model output was not parseable", {
			sessionKey: input.sessionKey,
			outputLength: modelOutput.length,
		});
		await writeArtifact(agentsDir, input.sessionKey, {
			sessionKey: input.sessionKey,
			ranAt: input.now ?? new Date().toISOString(),
			model: input.providerModel,
			tasksFilled: 0,
			status: "error",
			error: "unparseable output",
		});
		return { ran: false, reason: "error", tasksFilled: 0, model: input.providerModel, error: "unparseable output" };
	}

	const write = appendTaskSection({
		sessionKey: input.sessionKey,
		agentId: input.agentId,
		harness: input.harness,
		cwd: input.cwd,
		task: {
			taskIndex: targetIndex,
			outcome: body.outcome,
			preferenceSignals: body.preferenceSignals,
			keySteps: body.keySteps,
			failures: body.failures,
			reusableKnowledge: body.reusableKnowledge,
			references: body.references,
		},
		source: "consolidator",
		agentsDir,
		now: input.now,
	});
	if (!write.ok) {
		logger.warn("session-notes-consolidator", "Append failed", {
			sessionKey: input.sessionKey,
			error: write.error,
		});
		await writeArtifact(agentsDir, input.sessionKey, {
			sessionKey: input.sessionKey,
			ranAt: input.now ?? new Date().toISOString(),
			model: input.providerModel,
			tasksFilled: 0,
			status: "error",
			error: write.error,
		});
		return { ran: false, reason: "error", tasksFilled: 0, model: input.providerModel, error: write.error };
	}

	const afterRead = readSessionNotes(input.sessionKey, agentsDir);
	const afterFingerprint = afterRead.ok ? sessionNotesFingerprint(afterRead.file) : beforeFingerprint;

	await writeArtifact(agentsDir, input.sessionKey, {
		sessionKey: input.sessionKey,
		ranAt: input.now ?? new Date().toISOString(),
		model: input.providerModel,
		tasksFilled: 1,
		status: "ok",
	});

	logger.info("session-notes-consolidator", "Consolidated session", {
		sessionKey: input.sessionKey,
		taskIndex: targetIndex,
		beforeFingerprint,
		afterFingerprint,
		model: input.providerModel,
	});
	return { ran: true, tasksFilled: 1, model: input.providerModel };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildConsolidatorPrompt(taskIndex: number, summaryLine: string, transcript: string): string {
	return [
		"You are the Signet session notes consolidator.",
		`Fill the next missing \`## Task ${taskIndex}\` section for this session from the transcript.`,
		"Match the canonical Signet section schema exactly:",
		"",
		`## Task ${taskIndex}`,
		"",
		"Outcome:",
		"<one or two sentence summary of what was done>",
		"",
		"Preference signals:",
		"- <bullet> or (none captured)",
		"",
		"Key steps:",
		"- <bullet> or (none captured)",
		"",
		"Failures and how to do differently:",
		"- <bullet> or (none captured)",
		"",
		"Reusable knowledge:",
		"- <bullet> or (none captured)",
		"",
		"References:",
		"- <bullet> or (none captured)",
		"",
		"Rules:",
		"- Do not invent tasks. Only summarize what is in the transcript.",
		"- Reuse the literal section headings above; do not paraphrase them.",
		"- If a section has no evidence, write `(none captured)` as the only bullet.",
		"- Do not include any prose outside the section block.",
		"- Do not include any meta-commentary about your reasoning.",
		"",
		`Session summary so far: ${summaryLine || "(empty)"}`,
		`Target task index: ${taskIndex}`,
		"",
		"Transcript:",
		"```",
		transcript,
		"```",
		"",
		"Output the section block now.",
	].join("\n");
}

function extractTaskBody(raw: string, expectedIndex: number): ReturnType<typeof parseTaskSectionBody> {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const headingRe = new RegExp(`^##\\s+Task\\s+${expectedIndex}\\s*$`, "m");
	if (!headingRe.test(trimmed)) return null;
	const after = trimmed.replace(/^[\s\S]*?##\s+Task\s+\d+\s*\n/, "");
	return parseTaskSectionBody(after);
}

async function writeArtifact(agentsDir: string, sessionKey: string, artifact: ConsolidatorArtifact): Promise<void> {
	try {
		const dir = sessionNotesDir(sessionKey, agentsDir);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "consolidator.json");
		const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
		try {
			writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
			renameSync(tmp, path);
		} catch (err) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* nothing to do */
			}
			throw err;
		}
	} catch (err) {
		logger.warn("session-notes-consolidator", "Failed to write consolidator.json", {
			sessionKey,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// Exported for tests.
export const __testing = { extractTaskBody, buildConsolidatorPrompt };
