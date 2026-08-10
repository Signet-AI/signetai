/**
 * Deterministic content-safety policy for memory projections.
 *
 * Memory rows and source artifacts are evidence. This policy never rewrites or
 * deletes that evidence; it only decides whether a derived prompt-facing
 * projection may use it. Keep the rules deliberately high-confidence so
 * normal technical writing, shell examples, and security guidance remain
 * usable while instruction-shaped payloads are withheld from context.
 */

export const MEMORY_CONTENT_SAFETY_POLICY_VERSION = "memory-content-safety-v1";
export const MEMORY_CONTENT_WITHHELD_NOTICE = "[memory content withheld by safety policy]";

export const MEMORY_CONTENT_SAFETY_STATUSES = ["clean", "tainted", "blocked"] as const;
export type MemoryContentSafetyStatus = (typeof MEMORY_CONTENT_SAFETY_STATUSES)[number];

export const MEMORY_CONTENT_SAFETY_REASONS = [
	"prompt_injection",
	"exfiltration",
	"credential_harvesting",
	"malicious_shell",
	"tool_directive",
	"invisible_unicode",
] as const;
export type MemoryContentSafetyReason = (typeof MEMORY_CONTENT_SAFETY_REASONS)[number];

export interface MemoryContentSafetyAssessment {
	readonly status: MemoryContentSafetyStatus;
	readonly contextEligible: boolean;
	readonly reasons: readonly MemoryContentSafetyReason[];
	readonly policyVersion: string;
}

const INVISIBLE_UNICODE_RE =
	/(?:\u034f|[\u00ad\u061c\u070f\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\u206a-\u206f\ufeff]|[\u{e0000}-\u{e007f}])/u;
const STRONG_DEFENSIVE_CONTEXT_RE = /\b(?:security\s+(?:guidance|discussion|analysis)|threat\s+model|defensive)\b/i;
const REPORTING_CONTEXT_RE = /\b(?:example|illustrat\w*|sample|quote|quoted|detector|scanner|classif\w*)\b/i;
const REPORTING_BEFORE_RE =
	/\b(?:example|illustrat\w*|sample|quote|quoted|detector|scanner|classif\w*)\b[\s\S]{0,80}\b(?:say\w*|read\w*|show\w*|flag\w*|detect\w*|describ\w*|demonstrat\w*|contain\w*|match\w*|pattern)\b/i;
const REPORTING_AFTER_RE =
	/\b(?:detector|scanner|classif\w*|flag\w*|pattern|dangerous|unsafe|malicious|hostile|should|would|must|never|do not|don't|avoid|quoted)\b/i;
const NEGATED_DIRECTIVE_RE =
	/\b(?:never|do not|don't|should not|must not|cannot|can't|avoid|prevent|detect|mitigat\w*)\b[\s\S]{0,80}$/i;

const PROMPT_INJECTION_RES: readonly RegExp[] = [
	/\b(?:ignore|disregard|override|forget|bypass)\b[\s\S]{0,100}\b(?:previous|prior|above|earlier|system|developer|assistant|safety|security)?\s*(?:instructions?|rules?|prompt|message)\b/i,
	/\b(?:new|following|these)\s+(?:(?:system|developer|assistant|hidden)\s+)?instructions?\b/i,
	/(?:^|\n)\s*(?:system|developer|instruction|prompt)\s*:/im,
	/<\s*(?:system|developer|assistant|instruction|prompt)\b[^>]*>/i,
	/\b(?:you are now|act as|roleplay as|pretend to be)\b[\s\S]{0,80}\b(?:system|admin|developer|unrestricted|jailbreak|different agent)\b/i,
];

const TOOL_DIRECTIVE_RES: readonly RegExp[] = [
	/<\s*(?:tool[_-]?call|function[_-]?call|invoke|tool)\b/i,
	/\b(?:assistant|system)\s+to\s*=\s*[a-z0-9_.-]+/i,
	/\b(?:call|invoke|use|run|execute)\s+(?:the\s+)?[a-z0-9_.-]+\s+tool\b/i,
];

const EXFILTRATION_RE =
	/\b(?:reveal|show|print|send|upload|exfiltrat\w*|dump|forward|leak|transmit|export)\b[\s\S]{0,120}(?:\b(?:system\s+prompt|hidden\s+instructions?|secret(?:s)?|credential(?:s)?|password(?:s)?|api\s*keys?|tokens?|private\s+keys?|environment\s+variables?)\b|\.env\b|~\/(?:\.ssh)\/\S+|\/etc\/(?:shadow|passwd)\b)/i;
const EXFILTRATION_REVERSE =
	/(?:\b(?:system\s+prompt|hidden\s+instructions?|secret(?:s)?|credential(?:s)?|password(?:s)?|api\s*keys?|tokens?|private\s+keys?|environment\s+variables?)\b|\.env\b|~\/(?:\.ssh)\/\S+|\/etc\/(?:shadow|passwd)\b)[\s\S]{0,120}\b(?:reveal|show|print|send|upload|exfiltrat\w*|dump|forward|leak|transmit|export)\b/i;
const CREDENTIAL_HARVESTING_RE =
	/\b(?:enter|paste|provide|share|send|give|submit|type|hand over)\b[\s\S]{0,80}\b(?:password|api\s*key|token|secret|credential|private\s+key)\b/i;
const DANGEROUS_SHELL_RE =
	/\b(?:curl|wget)\b[^\n]{0,240}\|\s*(?:ba|z|fi)?sh\b|\brm\s+-rf\s+(?:\/|~|\.ssh)[^\n]{0,240}|\b(?:cat|head|tail)\s+~\/?\.ssh\/(?:id_[a-z]+|authorized_keys)\b|\b(?:printenv|env)\b[^\n]{0,120}\b(?:curl|wget|send|upload|post)\b/i;

function matchHasDefensiveContext(content: string, match: RegExpExecArray | null): boolean {
	if (!match || !match[0]) return false;
	const start = match.index ?? 0;
	const before = content.slice(Math.max(0, start - 120), start);
	const after = content.slice(start + match[0].length, start + match[0].length + 160);
	return (
		STRONG_DEFENSIVE_CONTEXT_RE.test(match[0]) ||
		NEGATED_DIRECTIVE_RE.test(before) ||
		STRONG_DEFENSIVE_CONTEXT_RE.test(before) ||
		STRONG_DEFENSIVE_CONTEXT_RE.test(after) ||
		REPORTING_BEFORE_RE.test(before) ||
		(REPORTING_CONTEXT_RE.test(before) && REPORTING_AFTER_RE.test(after))
	);
}

function hasActionableMatch(content: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		const searchable = new RegExp(pattern.source, flags);
		let match: RegExpExecArray | null;
		while ((match = searchable.exec(content)) !== null) {
			if (!matchHasDefensiveContext(content, match)) return true;
			if (match[0].length === 0) searchable.lastIndex += 1;
		}
		return false;
	});
}

function hasDangerousShell(content: string): boolean {
	const searchable = new RegExp(DANGEROUS_SHELL_RE.source, `${DANGEROUS_SHELL_RE.flags}g`);
	let match: RegExpExecArray | null;
	while ((match = searchable.exec(content)) !== null) {
		if (matchHasDefensiveContext(content, match)) continue;
		const end = (match.index ?? 0) + match[0].length;
		const after = content.slice(end, end + 160);
		if (!STRONG_DEFENSIVE_CONTEXT_RE.test(after) && !REPORTING_AFTER_RE.test(after)) return true;
		if (match[0].length === 0) searchable.lastIndex += 1;
	}
	return false;
}

/** Scan content without retaining or returning matched secret-like text. */
export function scanMemoryContent(content: string): MemoryContentSafetyAssessment {
	const raw = typeof content === "string" ? content : String(content ?? "");
	// NFKC makes visually equivalent directive spellings comparable, while the
	// invisible-character scan intentionally runs on the original bytes first.
	const normalized = raw.normalize("NFKC");
	const reasons = new Set<MemoryContentSafetyReason>();

	if (INVISIBLE_UNICODE_RE.test(raw)) reasons.add("invisible_unicode");
	if (hasActionableMatch(normalized, PROMPT_INJECTION_RES)) reasons.add("prompt_injection");
	if (hasActionableMatch(normalized, TOOL_DIRECTIVE_RES)) reasons.add("tool_directive");
	if (hasActionableMatch(normalized, [EXFILTRATION_RE, EXFILTRATION_REVERSE])) reasons.add("exfiltration");
	if (hasActionableMatch(normalized, [CREDENTIAL_HARVESTING_RE])) reasons.add("credential_harvesting");
	if (hasDangerousShell(normalized)) reasons.add("malicious_shell");

	const orderedReasons = MEMORY_CONTENT_SAFETY_REASONS.filter((reason) => reasons.has(reason));
	const status: MemoryContentSafetyStatus =
		orderedReasons.length === 0
			? "clean"
			: orderedReasons.every((reason) => reason === "invisible_unicode")
				? "tainted"
				: "blocked";

	return {
		status,
		contextEligible: status === "clean",
		reasons: orderedReasons,
		policyVersion: MEMORY_CONTENT_SAFETY_POLICY_VERSION,
	};
}

/** Descriptive alias for callers that prefer assessment terminology. */
export const assessMemoryContent = scanMemoryContent;

export function isMemoryContentContextEligible(value: MemoryContentSafetyAssessment | string): boolean {
	return typeof value === "string" ? scanMemoryContent(value).contextEligible : value.contextEligible;
}
