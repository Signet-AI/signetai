const CONCRETE_ENTITY_TYPES = [
	"person",
	"organization",
	"project",
	"product",
	"system",
	"tool",
	"artifact",
	"document",
	"source",
	"place",
	"event",
] as const;

export type ConcreteEntityType = (typeof CONCRETE_ENTITY_TYPES)[number];

export const CONCRETE_ENTITY_TYPE_SET = new Set<string>(CONCRETE_ENTITY_TYPES);

const ABSTRACT_OR_OPERATIONAL_TYPES = new Set([
	"concept",
	"task",
	"skill",
	"agent",
	"policy",
	"action",
	"workflow",
	"object_type",
	"interface",
	"observation",
	"claim_slot",
	"claim_value",
	"chunk_group",
]);

const GENERIC_CANONICAL_NAMES = new Set([
	"a",
	"an",
	"and",
	"are",
	"author",
	"because",
	"being",
	"but",
	"can",
	"current work",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"he",
	"her",
	"him",
	"his",
	"i",
	"in",
	"intent",
	"is",
	"it",
	"its",
	"let",
	"of",
	"on",
	"or",
	"pending tasks",
	"primary request",
	"read",
	"recipient",
	"sender",
	"she",
	"someone",
	"summary",
	"that",
	"the",
	"their",
	"them",
	"they",
	"this",
	"to",
	"understand",
	"want",
	"was",
	"we",
	"we're",
	"were",
	"with",
	"write",
	"you",
	"your",
]);

const METADATA_LABELS = new Set([
	"assistant",
	"author",
	"current work",
	"intent",
	"pending tasks",
	"primary request",
	"recipient",
	"sender",
	"system",
	"user",
]);

const DISCOURSE_WORDS = new Set([
	"because",
	"despite",
	"however",
	"let",
	"once",
	"read",
	"summary",
	"understand",
	"want",
	"write",
]);

const EVENT_WORDS =
	/\b(announce(?:d|ment)?|created|decided|deployed|digest|installed|launched|meeting|merged|published|released|started|stopped|updated)\b/i;
const DATE_OR_TIME =
	/\b(\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|today|yesterday|last\s+(?:night|week|month|year|daily))\b/i;

export interface EntityQualityResult {
	readonly ok: boolean;
	readonly reason?: string;
}

export function normalizeEntityName(value: string): string {
	return value
		.trim()
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/^['"`]+|['"`]+$/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ");
}

export function normalizeEntityType(value: string | undefined): string | undefined {
	const normalized = value
		?.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized || undefined;
}

export function isConcreteEntityType(type: string | undefined): type is ConcreteEntityType {
	return typeof type === "string" && CONCRETE_ENTITY_TYPE_SET.has(type);
}

export function isKnownAbstractEntityType(type: string | undefined): boolean {
	return typeof type === "string" && ABSTRACT_OR_OPERATIONAL_TYPES.has(type);
}

export function classifyEntityQuality(name: string, type?: string): EntityQualityResult {
	const canonical = normalizeEntityName(name);
	const normalizedType = normalizeEntityType(type);
	const hasConcreteType = isConcreteEntityType(normalizedType);

	if (/^\d+$/.test(canonical)) return { ok: false, reason: "numeric_only" };
	if (GENERIC_CANONICAL_NAMES.has(canonical)) return { ok: false, reason: "generic_or_scaffolding_name" };
	if (METADATA_LABELS.has(canonical)) return { ok: false, reason: "metadata_role" };
	if (DISCOURSE_WORDS.has(canonical)) return { ok: false, reason: "discourse_fragment" };
	if (/^(user|assistant|system|sender|recipient|author)\b[:\s-]+/i.test(name.trim())) {
		return { ok: false, reason: "role_prefixed_scaffolding" };
	}
	if (/^(current|pending|primary)\s+/i.test(canonical)) {
		return { ok: false, reason: "section_heading" };
	}
	if (canonical.length < 4 && !hasConcreteType) return { ok: false, reason: "too_short" };

	if (normalizedType && normalizedType !== "extracted" && normalizedType !== "unknown") {
		if (!isConcreteEntityType(normalizedType)) {
			return {
				ok: false,
				reason: isKnownAbstractEntityType(normalizedType) ? "non_concrete_entity_type" : "unknown_entity_type",
			};
		}
		if (normalizedType === "event" && !DATE_OR_TIME.test(name) && !EVENT_WORDS.test(name)) {
			return { ok: false, reason: "event_without_time_or_event_signal" };
		}
	}

	return { ok: true };
}

export function shouldPersistEntity(name: string, type?: string): boolean {
	return classifyEntityQuality(name, type).ok;
}

export function concreteEntityTypesForPrompt(): string {
	return CONCRETE_ENTITY_TYPES.join("|");
}
