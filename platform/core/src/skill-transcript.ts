/**
 * Pure transcript parser for Skill tool_use invocations.
 *
 * Accepts raw JSONL transcript content (no fs calls) so this function is
 * side-effect-free and testable without touching the filesystem.
 *
 * Replicates the pairing logic from scripts/backfill-skill-invocations.ts so
 * the daemon, CLI, and backfill script can share one canonical parser.
 */

export interface ParsedSkillInvocation {
	readonly skillName: string;
	readonly sessionId: string;
	readonly toolUseId: string; // the toolu_… id from the tool_use block
	readonly cwd: string;
	readonly args: string; // sliced to 2000 chars
	readonly success: boolean;
	readonly latencyMs: number; // wall-clock between message timestamps; includes idle gap
	readonly createdAtMs: number; // use.at epoch ms; 0 if unknown
}

interface PendingUse {
	readonly skillName: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly args: string;
	readonly at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMs(ts: unknown): number {
	if (typeof ts !== "string") return 0;
	const n = Date.parse(ts);
	return Number.isFinite(n) ? n : 0;
}

function toStr(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Parse a full JSONL transcript string and extract Skill tool_use invocations.
 *
 * Each Skill `tool_use` block in an `assistant` message is paired with its
 * matching `tool_result` (by `tool_use_id`) in a later `user` message.
 * Invocations with no matching result are counted in `skipped`; no record is
 * emitted for them (avoids fabricating success=true / latency=0).
 *
 * Malformed or unparseable lines are silently skipped — they never throw.
 */
export function parseTranscriptSkills(content: string): { records: ParsedSkillInvocation[]; skipped: number } {
	const uses = new Map<string, PendingUse>();
	const results = new Map<string, { readonly failed: boolean; readonly at: number }>();

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(row)) continue;

		const message = row.message;
		if (!isRecord(message)) continue;
		const contentBlocks = message.content;
		if (!Array.isArray(contentBlocks)) continue;

		const at = toMs(row.timestamp);

		for (const part of contentBlocks) {
			if (!isRecord(part)) continue;

			if (part.type === "tool_use" && part.name === "Skill") {
				const input = isRecord(part.input) ? part.input : {};
				const skillName = toStr(input.skill) || toStr(input.name) || toStr(input.skill_name);
				if (!skillName) continue;
				uses.set(toStr(part.id), {
					skillName,
					sessionId: toStr(row.sessionId),
					cwd: toStr(row.cwd),
					args: toStr(input.args) || JSON.stringify(input),
					at,
				});
			}

			if (part.type === "tool_result") {
				const id = toStr(part.tool_use_id);
				if (id) {
					results.set(id, { failed: part.is_error === true, at });
				}
			}
		}
	}

	let skipped = 0;
	const records: ParsedSkillInvocation[] = [];
	for (const [id, use] of uses) {
		const result = results.get(id);
		if (!result) {
			// No matching tool_result — session may have crashed mid-tool.
			// Skip rather than fabricate success=true, latency=0.
			skipped++;
			continue;
		}
		// latencyMs is wall-clock time between message timestamps; includes any
		// idle/queue gap before the result message — not pure tool exec time.
		const latencyMs = result.at > use.at ? result.at - use.at : 0;
		records.push({
			skillName: use.skillName,
			sessionId: use.sessionId,
			toolUseId: id,
			cwd: use.cwd,
			args: use.args.slice(0, 2000),
			success: !result.failed,
			latencyMs,
			createdAtMs: use.at,
		});
	}

	return { records, skipped };
}
