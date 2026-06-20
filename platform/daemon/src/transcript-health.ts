import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DbAccessor } from "./db-accessor";
import { type TranscriptCaptureStatusSummary, getTranscriptCaptureStatus } from "./transcript-capture-worker";

export interface TranscriptHealthReport {
	readonly ok: boolean;
	readonly agentId: string | null;
	readonly capture: TranscriptCaptureStatusSummary;
	readonly sessionStore: {
		readonly rows: number;
		readonly oldestUpdatedAt: string | null;
		readonly newestUpdatedAt: string | null;
	};
	readonly artifacts: {
		readonly manifests: number;
		readonly transcriptArtifacts: number;
		readonly summaryArtifacts: number;
		readonly pendingSummaries: number;
		readonly failedSummaries: number;
		readonly missingTranscriptArtifacts: number;
		readonly missingSummaryArtifacts: number;
	};
	readonly audit: {
		readonly latestLogs: number;
		readonly finalLogs: number;
		readonly newestAuditAt: string | null;
		readonly omittedReason?: string;
	};
}

function asCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function safeStatMtimeIso(path: string): string | null {
	try {
		return statSync(path).mtime.toISOString();
	} catch {
		return null;
	}
}

function scanAuditLogs(basePath: string): TranscriptHealthReport["audit"] {
	const root = join(basePath, ".daemon", "logs", "transcripts");
	if (!existsSync(root)) return { latestLogs: 0, finalLogs: 0, newestAuditAt: null };
	let latestLogs = 0;
	let finalLogs = 0;
	let newestAuditAt: string | null = null;
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
			if (entry.name === "latest.log" || entry.name.endsWith("--latest.log")) latestLogs++;
			else finalLogs++;
			const mtime = safeStatMtimeIso(full);
			if (mtime && (!newestAuditAt || mtime > newestAuditAt)) newestAuditAt = mtime;
		}
	};
	visit(root);
	return { latestLogs, finalLogs, newestAuditAt };
}

function pathExists(basePath: string, path: unknown): boolean {
	const rel = asStringOrNull(path);
	return rel ? existsSync(join(basePath, rel)) : false;
}

function readManifestValue(path: string, key: string): string | null {
	try {
		const body = readFileSync(path, "utf8");
		const match = body.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
		if (!match) return null;
		const raw = (match[1] ?? "").trim();
		if (!raw || raw === "null" || raw === "~") return null;
		return raw.replace(/^['\"]|['\"]$/g, "");
	} catch {
		return null;
	}
}

export function getTranscriptHealthReport(
	dbAccessor: DbAccessor,
	basePath: string,
	agentId?: string | null,
): TranscriptHealthReport {
	const capture = getTranscriptCaptureStatus(dbAccessor, agentId);
	const sessionStore = dbAccessor.withReadDb((db) => {
		const where = agentId ? "WHERE agent_id = ?" : "";
		const params = agentId ? [agentId] : [];
		const row = db
			.prepare(
				`SELECT COUNT(*) AS rows, MIN(updated_at) AS oldest_updated_at, MAX(updated_at) AS newest_updated_at
				 FROM session_transcripts ${where}`,
			)
			.get(...params) as Record<string, unknown> | undefined;
		return {
			rows: asCount(row?.rows),
			oldestUpdatedAt: asStringOrNull(row?.oldest_updated_at),
			newestUpdatedAt: asStringOrNull(row?.newest_updated_at),
		};
	});
	const artifacts = dbAccessor.withReadDb((db) => {
		const andAgent = agentId ? "AND agent_id = ?" : "";
		const params = agentId ? [agentId] : [];
		const countKind = (kind: string): number => {
			const row = db
				.prepare(`SELECT COUNT(*) AS count FROM memory_artifacts WHERE source_kind = ? ${andAgent}`)
				.get(kind, ...params) as Record<string, unknown> | undefined;
			return asCount(row?.count);
		};
		const manifestRows = db
			.prepare(`SELECT source_path FROM memory_artifacts WHERE source_kind = 'manifest' ${andAgent}`)
			.all(...params) as Array<Record<string, unknown>>;
		let pendingSummaries = 0;
		let failedSummaries = 0;
		let missingTranscriptArtifacts = 0;
		let missingSummaryArtifacts = 0;
		for (const row of manifestRows) {
			const sourcePath = asStringOrNull(row.source_path);
			if (!sourcePath) continue;
			const fullManifestPath = join(basePath, sourcePath);
			const summaryPath = readManifestValue(fullManifestPath, "summary_path");
			const summaryStatus = readManifestValue(fullManifestPath, "summary_status");
			const transcriptPath = readManifestValue(fullManifestPath, "transcript_path");
			const transcriptStatus = readManifestValue(fullManifestPath, "transcript_status");
			if (summaryStatus === "pending") pendingSummaries++;
			if (summaryStatus === "failed") failedSummaries++;
			if (summaryPath && !pathExists(basePath, summaryPath)) missingSummaryArtifacts++;
			if (
				(transcriptStatus === "completed" || (!transcriptStatus && transcriptPath)) &&
				!pathExists(basePath, transcriptPath)
			) {
				missingTranscriptArtifacts++;
			}
		}
		return {
			manifests: countKind("manifest"),
			transcriptArtifacts: countKind("transcript"),
			summaryArtifacts: countKind("summary"),
			pendingSummaries,
			failedSummaries,
			missingTranscriptArtifacts,
			missingSummaryArtifacts,
		};
	});
	const ok =
		capture.failed === 0 &&
		capture.dead === 0 &&
		artifacts.failedSummaries === 0 &&
		artifacts.missingTranscriptArtifacts === 0;
	return {
		ok,
		agentId: agentId ?? null,
		capture,
		sessionStore,
		artifacts,
		audit: agentId
			? {
					latestLogs: 0,
					finalLogs: 0,
					newestAuditAt: null,
					omittedReason: "legacy flat audit logs are not agent-scoped",
				}
			: scanAuditLogs(basePath),
	};
}
