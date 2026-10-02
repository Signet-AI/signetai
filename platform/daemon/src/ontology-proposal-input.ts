export type ProposalDraft = {
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly evidence?: readonly unknown[];
	readonly risk?: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readArray(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
	const value = record[key];
	return Array.isArray(value) ? value : [];
}

export function proposalInput(
	operation: string | null,
	payload: Record<string, unknown>,
	source: Readonly<Record<string, unknown>>,
	fallbackRationale: string,
): ProposalDraft | null {
	if (!operation || Object.keys(payload).length === 0) return null;
	return {
		operation,
		payload,
		confidence: readNumber(source, "confidence"),
		rationale: readString(source, "rationale") ?? readString(source, "reason") ?? fallbackRationale,
		evidence: readArray(source, "evidence"),
		risk: readString(source, "risk"),
	};
}
