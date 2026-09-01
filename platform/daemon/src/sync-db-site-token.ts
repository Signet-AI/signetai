export type SyncDbSourceLocationToken = `${string}:${number}`;
export type SyncDbWindowsSourceLocationToken = `${string}:${string}:${number}`;
export type SyncDbSemanticSiteToken = `db:${string}.${string}.${string}`;
export type SyncDbCallSiteToken =
	| SyncDbSourceLocationToken
	| SyncDbWindowsSourceLocationToken
	| SyncDbSemanticSiteToken;

const SOURCE_LOCATION_TOKEN = /^\/?[^:/]+(?:\/[^:/]+)*:\d+$/;
const WINDOWS_DRIVE_SOURCE_LOCATION_TOKEN = /^\/[A-Za-z]:\/[^:/]+(?:\/[^:/]+)*:\d+$/;
const SEMANTIC_TOKEN = /^db:[a-z0-9]+(?:[.-][a-z0-9]+){2,}$/;

export type SyncDbSiteTokenKind = "source-location" | "semantic";

function isSourceLocationToken(token: string): boolean {
	return SOURCE_LOCATION_TOKEN.test(token) || WINDOWS_DRIVE_SOURCE_LOCATION_TOKEN.test(token);
}

function isSafePathRemainder(value: string): boolean {
	if (value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
	return value
		.split("/")
		.every((segment) => segment.length > 0 && !segment.includes(":") && !hasControlCharacter(segment));
}

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});
}

function isWindowsPathRemainder(value: string): boolean {
	return isSafePathRemainder(value);
}

function normalizeSourcePath(path: string): string | null {
	const drive = /^(?:\/)?([A-Za-z]):[\\/]/.exec(path);
	if (drive) {
		const remainder = path.slice(drive[0].length).replaceAll("\\", "/");
		if (!isWindowsPathRemainder(remainder)) return null;
		return `/${drive[1]}:/${remainder}`;
	}
	if (path.startsWith("\\\\")) {
		const remainder = path.slice(2).replaceAll("\\", "/");
		if (!isWindowsPathRemainder(remainder) || remainder.split("/").length < 2) return null;
		return `/UNC/${remainder}`;
	}
	if (path.includes("\\")) return null;
	const remainder = path.startsWith("/") ? path.slice(1) : path;
	return isSafePathRemainder(remainder) ? path : null;
}

export function normalizeSyncDbSiteToken(token: string): SyncDbCallSiteToken | null {
	if (SEMANTIC_TOKEN.test(token)) return token as SyncDbSemanticSiteToken;
	const source = /^(.*):(\d+)$/.exec(token);
	if (!source) return null;
	const path = normalizeSourcePath(source[1] ?? "");
	if (path === null) return null;
	const normalized = `${path}:${source[2] ?? ""}`;
	if (!isSourceLocationToken(normalized)) return null;
	return normalized as SyncDbSourceLocationToken;
}

export function classifySyncDbSiteToken(token: string): SyncDbSiteTokenKind | null {
	const normalized = normalizeSyncDbSiteToken(token);
	if (normalized === null) return null;
	return SEMANTIC_TOKEN.test(normalized) ? "semantic" : "source-location";
}

export function isSemanticSyncDbSiteToken(token: string | null): token is SyncDbSemanticSiteToken {
	return token !== null && classifySyncDbSiteToken(token) === "semantic";
}
