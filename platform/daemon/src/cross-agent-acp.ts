import { isIP } from "node:net";

export interface AcpRelayRequest {
	readonly baseUrl: string;
	readonly targetAgentName: string;
	readonly content: string;
	readonly fromAgentId?: string;
	readonly fromSessionKey?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly timeoutMs?: number;
	readonly idempotencyKey?: string;
}

export interface AcpRelayResult {
	readonly ok: boolean;
	readonly status: number;
	readonly runId?: string;
	readonly error?: string;
	readonly indeterminate?: boolean;
}

const ACP_TIMEOUT_MS = 20_000;
const ACP_ALLOWED_ORIGINS_ENV = "SIGNET_ACP_ALLOWED_ORIGINS";
const MAX_ACP_TIMEOUT_MS = 120_000;

function normalizeText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneMetadata(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function parseAllowedAcpOrigins(raw: string | undefined): ReadonlySet<string> {
	const out = new Set<string>();
	const source = normalizeText(raw);
	if (!source) return out;

	for (const candidate of source.split(",")) {
		const trimmed = normalizeText(candidate);
		if (!trimmed) continue;
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
			out.add(parsed.origin);
		} catch {
			// Ignore malformed entries and continue with valid origins.
		}
	}

	return out;
}

function parseIpv4Octets(hostname: string): number[] | null {
	const parts = hostname.split(".");
	if (parts.length !== 4) return null;

	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d+$/.test(part)) return null;
		const value = Number.parseInt(part, 10);
		if (!Number.isInteger(value) || value < 0 || value > 255) return null;
		octets.push(value);
	}
	return octets;
}

function isPrivateIpv4(hostname: string): boolean {
	const octets = parseIpv4Octets(hostname);
	if (!octets) return false;

	const [a, b] = octets;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (normalized === "::1" || normalized === "::") return true;
	if (normalized.startsWith("fe80:")) return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		return isPrivateIpv4(mapped);
	}
	return false;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
		return true;
	}

	const ipType = isIP(normalized);
	if (ipType === 4) return isPrivateIpv4(normalized);
	if (ipType === 6) return isPrivateIpv6(normalized);

	// Single-label hosts are typically local network names.
	return !normalized.includes(".");
}

function resolveAcpRunsUrl(baseUrl: string): { ok: true; url: string } | { ok: false; error: string } {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return { ok: false, error: "acp.baseUrl must be a valid absolute URL" };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: "acp.baseUrl must use http or https" };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, error: "acp.baseUrl must not include credentials" };
	}

	const allowlist = parseAllowedAcpOrigins(process.env[ACP_ALLOWED_ORIGINS_ENV]);
	const allowlisted = allowlist.has(parsed.origin);

	if (!allowlisted) {
		if (parsed.protocol !== "https:") {
			return {
				ok: false,
				error: "acp.baseUrl must use https unless explicitly allowlisted via SIGNET_ACP_ALLOWED_ORIGINS",
			};
		}

		if (isPrivateOrLocalHostname(parsed.hostname)) {
			return {
				ok: false,
				error: "acp.baseUrl host is private/local and must be explicitly allowlisted via SIGNET_ACP_ALLOWED_ORIGINS",
			};
		}
	}

	return { ok: true, url: new URL("/runs", parsed).toString() };
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractRunId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;

	const direct = readStringField(value, "run_id") ?? readStringField(value, "runId") ?? readStringField(value, "id");
	if (direct) return direct;

	const nested = value.run;
	if (!isRecord(nested)) return undefined;
	return readStringField(nested, "run_id") ?? readStringField(nested, "runId") ?? readStringField(nested, "id");
}

export async function relayMessageViaAcp(request: AcpRelayRequest): Promise<AcpRelayResult> {
	const baseUrl = normalizeText(request.baseUrl);
	if (!baseUrl) return { ok: false, status: 0, error: "acp.baseUrl is required" };

	const targetAgentName = normalizeText(request.targetAgentName);
	if (!targetAgentName) return { ok: false, status: 0, error: "acp.targetAgentName is required" };

	const content = normalizeText(request.content);
	if (!content) return { ok: false, status: 0, error: "content is required" };

	const timeoutMs =
		typeof request.timeoutMs === "number" && request.timeoutMs > 0
			? Math.min(MAX_ACP_TIMEOUT_MS, request.timeoutMs)
			: ACP_TIMEOUT_MS;
	const runsUrl = resolveAcpRunsUrl(baseUrl);
	if (!runsUrl.ok) return { ok: false, status: 0, error: runsUrl.error };

	const payload: Record<string, unknown> = {
		agent_name: targetAgentName,
		mode: "sync",
		input: [
			{
				role: "user",
				parts: [{ content_type: "text/plain", content }],
			},
		],
	};

	const metadata: Record<string, unknown> = {
		from_agent_id: normalizeText(request.fromAgentId) ?? "default",
	};
	const fromSessionKey = normalizeText(request.fromSessionKey);
	if (fromSessionKey) metadata.from_session_key = fromSessionKey;
	if (request.metadata && Object.keys(request.metadata).length > 0) {
		metadata.signet = cloneMetadata(request.metadata);
	}
	payload.metadata = metadata;

	try {
		const response = await fetch(runsUrl.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(normalizeText(request.idempotencyKey) ? { "Idempotency-Key": normalizeText(request.idempotencyKey) } : {}),
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs),
		});

		let parsedBody: unknown = null;
		try {
			parsedBody = await response.json();
		} catch {
			parsedBody = null;
		}

		if (!response.ok) {
			const error =
				isRecord(parsedBody) && typeof parsedBody.error === "string"
					? parsedBody.error
					: `ACP request failed with ${response.status}`;
			return {
				ok: false,
				status: response.status,
				error,
				indeterminate: response.status >= 500,
			};
		}

		return { ok: true, status: response.status, runId: extractRunId(parsedBody) };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			error: error instanceof Error ? error.message : String(error),
			indeterminate: true,
		};
	}
}
