export interface PersonalMemory {
	readonly id: string;
	readonly content: string;
	readonly agent_id: string;
	readonly evidence: Readonly<Record<string, unknown>>;
}

const MAX_BYTES = 4 * 1024 * 1024;

export function parsePersonalMemories(text: string): readonly PersonalMemory[] {
	if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("Export exceeds 4 MiB");
	const lines = text.split("\n").filter((line) => line.trim());
	if (!lines.length || lines.length > 1000) throw new Error("Choose an export containing 1–1,000 memories");
	const seen = new Set<string>();
	return lines.map((line) => {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid memory export");
		const row = Object.fromEntries(Object.entries(value));
		if (
			typeof row.id !== "string" ||
			!row.id ||
			row.id.length > 200 ||
			typeof row.content !== "string" ||
			!row.content.trim() ||
			row.content.length > 100_000 ||
			typeof row.agent_id !== "string" ||
			!row.agent_id ||
			row.agent_id.length > 200
		)
			throw new Error("Choose the memories.jsonl file from your personal export");
		const identity = JSON.stringify([row.agent_id, row.id]);
		if (seen.has(identity)) throw new Error("Duplicate memory identity");
		seen.add(identity);
		return { id: row.id, content: row.content, agent_id: row.agent_id, evidence: row };
	});
}

export function personalMemoryCopy(
	rows: readonly PersonalMemory[],
	selected: readonly string[],
	agentId: string,
): File {
	if (!selected.length) throw new Error("Select at least one memory");
	const ids = new Set(selected);
	const memories = rows.filter((row) => row.agent_id === agentId && ids.has(row.id));
	if (ids.size !== selected.length || memories.length !== ids.size) throw new Error("Selection is unavailable");
	const content = JSON.stringify({
		format: "signet-personal-evidence-v1",
		originalAgentId: agentId,
		memories: memories.map((row) => row.evidence),
	});
	if (new TextEncoder().encode(content).byteLength > MAX_BYTES) throw new Error("Copy exceeds 4 MiB");
	return new File([new TextEncoder().encode(content)], "personal-memory-evidence.json", { type: "application/json" });
}
