import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

export type PluginAuditResultV1 = "ok" | "denied" | "degraded" | "error";
export type PluginAuditSourceV1 = "plugin-host" | "secrets-provider" | "secrets-routes";

export interface PluginAuditEventV1 {
	readonly id: string;
	readonly timestamp: string;
	readonly event: string;
	readonly pluginId: string;
	readonly result: PluginAuditResultV1;
	readonly source: PluginAuditSourceV1;
	readonly agentId?: string;
	readonly data: Record<string, unknown>;
}

export interface RecordPluginAuditEventInputV1 {
	readonly event: string;
	readonly pluginId: string;
	readonly result?: PluginAuditResultV1;
	readonly source: PluginAuditSourceV1;
	readonly agentId?: string;
	readonly data?: Record<string, unknown>;
	readonly timestamp?: string;
}

export interface PluginAuditQueryV1 {
	readonly pluginId?: string;
	readonly event?: string;
	readonly since?: string;
	readonly until?: string;
	readonly limit?: number;
	readonly auditPath?: string | null;
}

export interface PluginAuditListResponseV1 {
	readonly events: readonly PluginAuditEventV1[];
	readonly count: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const SENSITIVE_KEY_RE =
	/(^|[_-])(api-key|apikey|auth-token|authorization|bearer|client-secret|credential|credentials|password|private-key|refresh-token|secret|secret-value|token|value)([_-]|$)/i;
const SENSITIVE_ASSIGNMENT_RE =
	/\b((?:access[_-]?token|api[_-]?key|auth(?:orization)?|bearer|client[_-]?secret|credential|password|refresh[_-]?token|secret|token)\s*[:=]\s*)(["']?)([^"'\s,;&]+)/gi;
const KNOWN_SECRET_VALUE_RE =
	/\b(AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

export function getDefaultPluginAuditPath(): string {
	return join(process.env.SIGNET_PATH || join(homedir(), ".agents"), ".daemon", "plugins", "audit-v1.ndjson");
}

export function recordPluginAuditEvent(input: RecordPluginAuditEventInputV1, auditPath?: string | null): void {
	if (auditPath === null) return;
	const path = auditPath ?? getDefaultPluginAuditPath();
	const event: PluginAuditEventV1 = {
		id: makeAuditId(),
		timestamp: input.timestamp ?? new Date().toISOString(),
		event: input.event,
		pluginId: input.pluginId,
		result: input.result ?? "ok",
		source: input.source,
		...(input.agentId ? { agentId: input.agentId } : {}),
		data: sanitizeAuditData(input.data ?? {}),
	};
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	} catch (err) {
		logger.warn("plugins", "Failed to write plugin audit event", {
			event: input.event,
			pluginId: input.pluginId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function queryPluginAuditEvents(query: PluginAuditQueryV1 = {}): PluginAuditListResponseV1 {
	if (query.auditPath === null) return { events: [], count: 0 };
	const path = query.auditPath ?? getDefaultPluginAuditPath();
	if (!path || !existsSync(path)) return { events: [], count: 0 };
	const sinceMs = parseOptionalTime(query.since);
	const untilMs = parseOptionalTime(query.until);
	const limit = clampLimit(query.limit);
	const events: PluginAuditEventV1[] = [];
	const content = readAuditFile(path);
	if (content === null) return { events: [], count: 0 };
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const event = parseAuditEvent(line);
		if (!event) continue;
		if (query.pluginId && event.pluginId !== query.pluginId) continue;
		if (query.event && event.event !== query.event) continue;
		const timestampMs = Date.parse(event.timestamp);
		if (sinceMs !== undefined && timestampMs < sinceMs) continue;
		if (untilMs !== undefined && timestampMs > untilMs) continue;
		events.push(event);
	}
	const latest = events.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
	return { events: latest, count: latest.length };
}

function readAuditFile(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch (err) {
		logger.warn("plugins", "Failed to read plugin audit events", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

function parseAuditEvent(line: string): PluginAuditEventV1 | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed)) return null;
		if (
			typeof parsed.id !== "string" ||
			typeof parsed.timestamp !== "string" ||
			typeof parsed.event !== "string" ||
			typeof parsed.pluginId !== "string" ||
			typeof parsed.result !== "string" ||
			typeof parsed.source !== "string" ||
			!isRecord(parsed.data)
		) {
			return null;
		}
		return {
			id: parsed.id,
			timestamp: parsed.timestamp,
			event: parsed.event,
			pluginId: parsed.pluginId,
			result: parseAuditResult(parsed.result),
			source: parseAuditSource(parsed.source),
			...(typeof parsed.agentId === "string" ? { agentId: parsed.agentId } : {}),
			data: sanitizeAuditData(parsed.data),
		};
	} catch {
		return null;
	}
}

function sanitizeAuditData(data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (isSensitiveAuditKey(key)) {
			out[key] = "[REDACTED]";
			continue;
		}
		out[key] = sanitizeAuditValue(value);
	}
	return out;
}

function isSensitiveAuditKey(key: string): boolean {
	const normalized = key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
	return SENSITIVE_KEY_RE.test(normalized);
}

function sanitizeAuditValue(value: unknown): unknown {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return sanitizeAuditString(value);
	if (Array.isArray(value)) return value.map((entry) => sanitizeAuditValue(entry));
	if (isRecord(value)) return sanitizeAuditData(value);
	return String(value);
}

function sanitizeAuditString(value: string): string {
	return value
		.replace(SENSITIVE_ASSIGNMENT_RE, (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]`)
		.replace(KNOWN_SECRET_VALUE_RE, "[REDACTED]");
}

function parseAuditResult(value: string): PluginAuditResultV1 {
	if (value === "denied" || value === "degraded" || value === "error") return value;
	return "ok";
}

function parseAuditSource(value: string): PluginAuditSourceV1 {
	if (value === "secrets-provider" || value === "secrets-routes") return value;
	return "plugin-host";
}

function parseOptionalTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function clampLimit(value: number | undefined): number {
	if (!value || !Number.isFinite(value)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

function makeAuditId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
