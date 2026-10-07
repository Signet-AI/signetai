export const REDACTED_CREDENTIAL = "[redacted credential]";

export const CREDENTIAL_KINDS = ["private_key", "provider_key", "jwt", "bearer_token", "secret_assignment"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface CredentialSpan {
	readonly kind: CredentialKind;
	readonly start: number;
	readonly end: number;
}

interface CredentialPattern {
	readonly kind: CredentialKind;
	readonly pattern: RegExp;
	readonly valueGroup?: number;
}

const SECRET_NAMES =
	"(?:access[_-]?token|api[_-]?key|apikey|auth[_-]?token|client[_-]?secret|passw(?:or)?d|refresh[_-]?token|private[_-]?key|secret(?:[_-]?key)?|token)";

const SECRET_VALUE = "(?=[^\\s\"',;&<>()\\[\\]{}$]*\\d)[^\\s\"',;&<>()\\[\\]{}$]{8,}";

const PATTERNS: readonly CredentialPattern[] = [
	{
		kind: "private_key",
		pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
	},
	{
		kind: "provider_key",
		pattern:
			/\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b/g,
	},
	{
		kind: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	},
	{
		kind: "bearer_token",
		pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g,
		valueGroup: 1,
	},
	{
		kind: "secret_assignment",
		pattern: new RegExp(`\\b${SECRET_NAMES}["']?\\s*[:=]\\s*["']?(${SECRET_VALUE})`, "gi"),
		valueGroup: 1,
	},
	{
		kind: "secret_assignment",
		pattern: new RegExp(`\\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\\s*=\\s*["']?(${SECRET_VALUE})`, "g"),
		valueGroup: 1,
	},
];

export function findCredentialSpans(text: string): CredentialSpan[] {
	const spans: CredentialSpan[] = [];
	for (const { kind, pattern, valueGroup } of PATTERNS) {
		const searchable = new RegExp(pattern.source, pattern.flags);
		let match: RegExpExecArray | null;
		while ((match = searchable.exec(text)) !== null) {
			const value = valueGroup === undefined ? match[0] : match[valueGroup];
			if (value === undefined || value.length === 0) continue;
			const start = valueGroup === undefined ? match.index : match.index + match[0].lastIndexOf(value);
			spans.push({ kind, start, end: start + value.length });
			if (match[0].length === 0) searchable.lastIndex += 1;
		}
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: CredentialSpan[] = [];
	for (const span of spans) {
		const last = merged.at(-1);
		if (last !== undefined && span.start < last.end) {
			if (span.end > last.end) merged[merged.length - 1] = { ...last, end: span.end };
			continue;
		}
		merged.push(span);
	}
	return merged;
}

export function redactCredentials(text: string, replacement: string = REDACTED_CREDENTIAL): string {
	const spans = findCredentialSpans(text);
	if (spans.length === 0) return text;
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		out += text.slice(cursor, span.start) + replacement;
		cursor = span.end;
	}
	return out + text.slice(cursor);
}

export function redactCredentialsDeep<T>(value: T): T {
	if (typeof value === "string") return redactCredentials(value) as T;
	if (Array.isArray(value)) return value.map((entry) => redactCredentialsDeep(entry)) as T;
	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = redactCredentialsDeep(entry);
		return out as T;
	}
	return value;
}
