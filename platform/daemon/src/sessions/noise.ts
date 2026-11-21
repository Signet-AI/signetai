export interface SessionNoiseSeed {
	readonly project?: string | null;
	readonly sessionId?: string | null;
	readonly sessionKey?: string | null;
	readonly harness?: string | null;
}

const TEMP_PREFIXES = ["/tmp/", "/private/tmp/"] as const;
const SYNTHETIC_PREFIXES = ["test-", "spec-", "fixture-", "synthetic-", "tmp-"] as const;

function clean(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function isTempProject(project: string | null | undefined): boolean {
	const value = clean(project);
	if (!value) return false;
	return TEMP_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hasSyntheticPrefix(value: string | null | undefined): boolean {
	const text = clean(value)?.toLowerCase();
	if (!text) return false;
	return SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function isNoiseSession(seed: SessionNoiseSeed): boolean {
	if (isTempProject(seed.project)) return true;
	if (clean(seed.project)) return false;
	if (hasSyntheticPrefix(seed.sessionKey)) return true;
	if (hasSyntheticPrefix(seed.sessionId)) return true;
	return clean(seed.harness)?.toLowerCase() === "test";
}
