export interface ParsedSkillInvocation {
	readonly skillName: string;
	readonly sessionId: string;
	readonly toolUseId: string;
	readonly cwd: string;
	readonly args: string;
	readonly success: boolean;
	readonly latencyMs: number;
	readonly createdAtMs: number;
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
			skipped++;
			continue;
		}
		const latencyMs = use.at > 0 && result.at >= use.at ? result.at - use.at : 0;
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
