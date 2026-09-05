/**
 * Bounded attribution for transitional synchronous SQLite calls.
 *
 * The event-loop monitor runs on the same isolate as SQLite, so a monitor tick
 * cannot observe a synchronous call while it is executing. We retain a bounded
 * interval history and match the observed stall window against calls that
 * overlapped it. Normal calls record only timestamps and a small token. Caller
 * stack capture is deliberately lazy: it happens only when a call is slow
 * enough to explain an event-loop stall. No SQL, arguments, or user data are
 * retained.
 */

import { classifySyncDbSiteToken, normalizeSyncDbSiteToken, type SyncDbCallSiteToken } from "./sync-db-site-token";

export type { SyncDbCallSiteToken } from "./sync-db-site-token";

export type SyncDbCallKind =
	| "withReadDb"
	| "withWriteTx"
	| "withReadDbAsync"
	| "withWriteTxAsync"
	| "withWriteDbAsync"
	| "checkpointWalAsync"
	| "incrementalVacuumAsync"
	| "vacuumConversionAsync";
export interface SyncDbCallToken {
	readonly sequence: number;
	readonly siteId: string;
	readonly kind: SyncDbCallKind;
	readonly startedAtMs: number;
}

export interface SyncDbAttributionMetrics {
	readonly calls: number;
	readonly slowCalls: number;
	readonly totalDurationMs: number;
	readonly maxDurationMs: number;
	readonly unattributedCalls: number;
	readonly unattributedDurationMs: number;
	readonly unattributedSlowDurationMs: number;
	readonly sites: readonly SyncDbCallSiteMetrics[];
}

export interface SyncDbCallSiteMetrics {
	readonly siteId: string;
	readonly calls: number;
	readonly slowCalls: number;
	readonly totalDurationMs: number;
	readonly maxDurationMs: number;
}

interface SyncDbCallRecord {
	readonly sequence: number;
	readonly kind: SyncDbCallKind;
	readonly startedAtMs: number;
	readonly hasSiteToken: boolean;
	endedAtMs: number | null;
	durationMs: number | null;
	siteId: string;
}

const MAX_HISTORY = 256;
const SLOW_CALL_THRESHOLD_MS = 50;
const UNATTRIBUTED_SITE = "unattributed";
const SITE_TOKEN_PREFIX = "platform/daemon/src/";
const history: SyncDbCallRecord[] = [];
const inFlight = new Map<number, SyncDbCallRecord>();
const siteTokenCache = new Map<SyncDbCallSiteToken, string>();
const siteMetrics = new Map<
	string,
	{ calls: number; slowCalls: number; totalDurationMs: number; maxDurationMs: number }
>();
const FAST_PATH_SEQUENCE = 0;
let nextSequence = 1;
let calls = 0;
let slowCalls = 0;
let totalDurationMs = 0;
let maxDurationMs = 0;
let unattributedCalls = 0;
let unattributedDurationMs = 0;
let unattributedSlowDurationMs = 0;

function normalizeFileName(value: string): string {
	let normalized = value;
	if (value.startsWith("file://")) {
		try {
			normalized = decodeURIComponent(new URL(value).pathname);
		} catch {
			normalized = value.slice("file://".length);
		}
	}
	return normalized.replaceAll("\\", "/");
}

function parseFrame(
	line: string,
): { readonly file: string; readonly line: number; readonly functionName: string } | null {
	const parenthesizedMatch = /\(((?:file:\/\/)?[^()]+):(\d+):\d+\)?$/.exec(line);
	const bareMatch = /^\s*at\s+((?:file:\/\/)?[^()]+):(\d+):\d+\)?$/.exec(line);
	const match = parenthesizedMatch ?? bareMatch;
	if (!match) return null;
	const lineNumber = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isInteger(lineNumber) || lineNumber <= 0) return null;
	const functionName = parenthesizedMatch
		? line
				.replace(/\s+\([^()]+\)$/, "")
				.replace(/^\s*at\s+/, "")
				.trim()
		: "";
	return { file: normalizeFileName(match[1] ?? ""), line: lineNumber, functionName };
}

/** Resolve the first frame outside the attribution/accessor implementation. */
function captureCallerSite(): string {
	const stack = new Error().stack?.split("\n").slice(1) ?? [];
	for (const frame of stack) {
		const parsed = parseFrame(frame);
		if (!parsed) continue;
		if (
			parsed.functionName.endsWith("captureCallerSite") ||
			parsed.functionName.endsWith("beginSyncDbCall") ||
			parsed.functionName.endsWith("endSyncDbCall") ||
			parsed.functionName.endsWith("captureSyncDbCallSiteToken") ||
			parsed.functionName.endsWith("runWriteTxAsync") ||
			parsed.functionName.endsWith("withReadDb") ||
			parsed.functionName.endsWith("withWriteTx") ||
			parsed.functionName.endsWith("withReadDbAsync") ||
			parsed.functionName.endsWith("withWriteTxAsync") ||
			parsed.functionName.endsWith("checkpointWalAsync") ||
			parsed.functionName.endsWith("incrementalVacuumAsync") ||
			parsed.functionName.endsWith("vacuumConversionAsync") ||
			parsed.file.endsWith("/sync-db-attribution.ts") ||
			parsed.file.endsWith("/db-accessor.ts") ||
			parsed.file.startsWith("node:") ||
			parsed.file.startsWith("bun:")
		) {
			continue;
		}
		return `${parsed.file}:${parsed.line}`;
	}
	return UNATTRIBUTED_SITE;
}

function resolveSiteToken(siteToken: SyncDbCallSiteToken | undefined): string {
	if (siteToken === undefined) return UNATTRIBUTED_SITE;
	const cached = siteTokenCache.get(siteToken);
	if (cached !== undefined) return cached;
	const normalized = normalizeSyncDbSiteToken(siteToken);
	if (normalized === null) return UNATTRIBUTED_SITE;
	const kind = classifySyncDbSiteToken(normalized);
	if (kind === null) return UNATTRIBUTED_SITE;
	const resolved = kind === "semantic" || normalized.startsWith("/") ? normalized : `${SITE_TOKEN_PREFIX}${normalized}`;
	siteTokenCache.set(siteToken, resolved);
	return resolved;
}

export function beginSyncDbCall(
	kind: SyncDbCallKind,
	startedAtMs = Date.now(),
	siteToken?: SyncDbCallSiteToken,
): SyncDbCallToken {
	if (siteToken === undefined) {
		// Unmarked calls cannot be named while they are executing. Keep their
		// normal-path cost to a timestamp token and recover a caller frame only
		// when the completed call is slow enough to matter.
		return { sequence: FAST_PATH_SEQUENCE, siteId: "", kind, startedAtMs };
	}
	const record: SyncDbCallRecord = {
		sequence: nextSequence++,
		kind,
		startedAtMs,
		hasSiteToken: siteToken !== undefined,
		endedAtMs: null,
		durationMs: null,
		siteId: `${kind}@${resolveSiteToken(siteToken)}`,
	};
	inFlight.set(record.sequence, record);
	return {
		sequence: record.sequence,
		siteId: record.siteId,
		kind,
		startedAtMs,
	};
}

export function endSyncDbCall(token: SyncDbCallToken, endedAtMs = Date.now()): void {
	if (token.sequence === FAST_PATH_SEQUENCE) {
		const durationMs = Math.max(token.startedAtMs, endedAtMs) - token.startedAtMs;
		calls++;
		totalDurationMs += durationMs;
		maxDurationMs = Math.max(maxDurationMs, durationMs);
		const isSlow = durationMs >= SLOW_CALL_THRESHOLD_MS;
		if (!isSlow) {
			unattributedCalls++;
			unattributedDurationMs += durationMs;
			return;
		}
		slowCalls++;
		const siteId = `${token.kind}@${captureCallerSite()}`;
		const record: SyncDbCallRecord = {
			sequence: FAST_PATH_SEQUENCE,
			kind: token.kind,
			startedAtMs: token.startedAtMs,
			hasSiteToken: false,
			endedAtMs: Math.max(token.startedAtMs, endedAtMs),
			durationMs,
			siteId,
		};
		if (siteId.endsWith(`@${UNATTRIBUTED_SITE}`)) {
			unattributedCalls++;
			unattributedDurationMs += durationMs;
			unattributedSlowDurationMs += durationMs;
		} else {
			const site = siteMetrics.get(siteId) ?? {
				calls: 0,
				slowCalls: 0,
				totalDurationMs: 0,
				maxDurationMs: 0,
			};
			site.calls++;
			site.slowCalls++;
			site.totalDurationMs += durationMs;
			site.maxDurationMs = Math.max(site.maxDurationMs, durationMs);
			siteMetrics.set(siteId, site);
		}
		history.push(record);
		if (history.length > MAX_HISTORY) history.shift();
		return;
	}
	const record = inFlight.get(token.sequence);
	if (!record) return;
	inFlight.delete(token.sequence);
	record.endedAtMs = Math.max(token.startedAtMs, endedAtMs);
	record.durationMs = record.endedAtMs - token.startedAtMs;
	const isSlow = record.durationMs >= SLOW_CALL_THRESHOLD_MS;
	if (isSlow && !record.hasSiteToken) {
		// This is the only hot-path escape: normal calls never construct or parse a stack.
		record.siteId = `${record.kind}@${captureCallerSite()}`;
	}
	calls++;
	totalDurationMs += record.durationMs;
	maxDurationMs = Math.max(maxDurationMs, record.durationMs);
	if (isSlow) slowCalls++;
	if (record.siteId.endsWith(`@${UNATTRIBUTED_SITE}`)) {
		unattributedCalls++;
		unattributedDurationMs += record.durationMs;
		if (isSlow) unattributedSlowDurationMs += record.durationMs;
	} else {
		const site = siteMetrics.get(record.siteId) ?? {
			calls: 0,
			slowCalls: 0,
			totalDurationMs: 0,
			maxDurationMs: 0,
		};
		site.calls++;
		site.totalDurationMs += record.durationMs;
		site.maxDurationMs = Math.max(site.maxDurationMs, record.durationMs);
		if (isSlow) site.slowCalls++;
		siteMetrics.set(record.siteId, site);
	}
	history.push(record);
	if (history.length > MAX_HISTORY) history.shift();
}

/** Capture the caller token before an async helper queues work on the owner. */
export function captureSyncDbCallSiteToken(): SyncDbCallSiteToken | undefined {
	const site = captureCallerSite();
	if (site === UNATTRIBUTED_SITE) return undefined;
	const normalizedSite = normalizeSyncDbSiteToken(site);
	if (normalizedSite === null) return undefined;
	const prefixIndex = normalizedSite.lastIndexOf(SITE_TOKEN_PREFIX);
	const token = prefixIndex >= 0 ? normalizedSite.slice(prefixIndex + SITE_TOKEN_PREFIX.length) : normalizedSite;
	return normalizeSyncDbSiteToken(token) ?? undefined;
}

/** Return site ids whose synchronous interval overlapped the observed stall. */
export function getSyncDbCallSitesForWindow(startMs: number, endMs: number): readonly string[] {
	const sites = new Set<string>();
	for (const record of [...history, ...inFlight.values()]) {
		const recordEnd = record.endedAtMs ?? endMs;
		if (record.startedAtMs <= endMs && recordEnd >= startMs) sites.add(record.siteId);
	}
	return [...sites].sort();
}

export function getSyncDbAttributionMetrics(): SyncDbAttributionMetrics {
	return {
		calls,
		slowCalls,
		totalDurationMs,
		maxDurationMs,
		unattributedCalls,
		unattributedDurationMs,
		unattributedSlowDurationMs,
		sites: [...siteMetrics.entries()]
			.map(([siteId, site]) => ({ siteId, ...site }))
			.sort((a, b) => b.totalDurationMs - a.totalDurationMs),
	};
}

export function resetSyncDbAttribution(): void {
	history.length = 0;
	inFlight.clear();
	siteMetrics.clear();
	siteTokenCache.clear();
	nextSequence = 1;
	calls = 0;
	slowCalls = 0;
	totalDurationMs = 0;
	maxDurationMs = 0;
	unattributedCalls = 0;
	unattributedDurationMs = 0;
	unattributedSlowDurationMs = 0;
}
