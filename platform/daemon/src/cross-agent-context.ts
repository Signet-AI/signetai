import { redactCredentials } from "@signet/core";

export interface AgentPresenceContext {
	readonly cwd?: string;
	readonly hostname?: string;
	readonly title?: string;
	readonly task?: string;
	readonly modifiedFiles?: readonly string[];
	readonly resources?: readonly string[];
}

export type AgentPresenceContextPatch = AgentPresenceContext;

export const PRESENCE_CONTEXT_LIMITS = {
	cwd: 512,
	hostname: 128,
	title: 160,
	task: 500,
	modifiedFiles: { items: 20, chars: 300 },
	resources: { items: 20, chars: 160 },
} as const;

const SCALAR_KEYS = ["cwd", "hostname", "title", "task"] as const;
const ARRAY_KEYS = ["modifiedFiles", "resources"] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set([...SCALAR_KEYS, ...ARRAY_KEYS]);

function isStrippedCodePoint(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x2028 && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x2069) ||
		code === 0xfeff
	);
}

export function sanitizeContextText(value: string): string {
	let out = "";
	for (const char of value) out += isStrippedCodePoint(char.codePointAt(0) ?? 0) ? " " : char;
	return out.replace(/\s+/g, " ").trim();
}

export type ParsedContext =
	| { readonly ok: true; readonly patch: AgentPresenceContextPatch | undefined }
	| { readonly ok: false; readonly error: string };

export function parsePresenceContext(raw: unknown): ParsedContext {
	if (raw === undefined) return { ok: true, patch: undefined };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "context must be an object" };
	}
	const input = raw as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `context.${key} is not a supported field` };
	}
	const patch: { -readonly [K in keyof AgentPresenceContext]: AgentPresenceContext[K] } = {};
	for (const key of SCALAR_KEYS) {
		const value = input[key];
		if (value === undefined) continue;
		if (typeof value !== "string") return { ok: false, error: `context.${key} must be a string` };
		const limit = PRESENCE_CONTEXT_LIMITS[key];
		if (value.length > limit * 4) return { ok: false, error: `context.${key} exceeds ${limit} characters` };
		const clean = sanitizeContextText(redactCredentials(value));
		if (clean.length > limit) return { ok: false, error: `context.${key} exceeds ${limit} characters` };
		patch[key] = clean;
	}
	for (const key of ARRAY_KEYS) {
		const value = input[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) return { ok: false, error: `context.${key} must be an array of strings` };
		const limit = PRESENCE_CONTEXT_LIMITS[key];
		if (value.length > limit.items) return { ok: false, error: `context.${key} exceeds ${limit.items} entries` };
		const out: string[] = [];
		for (const entry of value) {
			if (typeof entry !== "string") return { ok: false, error: `context.${key} must be an array of strings` };
			if (entry.length > limit.chars * 4)
				return { ok: false, error: `context.${key} entry exceeds ${limit.chars} characters` };
			const clean = sanitizeContextText(redactCredentials(entry));
			if (clean.length > limit.chars)
				return { ok: false, error: `context.${key} entry exceeds ${limit.chars} characters` };
			if (clean.length > 0 && !out.includes(clean)) out.push(clean);
		}
		patch[key] = out;
	}
	return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}

export function isEmptyContext(context: AgentPresenceContext | undefined): boolean {
	if (!context) return true;
	for (const key of SCALAR_KEYS) if (context[key]) return false;
	for (const key of ARRAY_KEYS) if ((context[key]?.length ?? 0) > 0) return false;
	return true;
}

export function mergePresenceContext(
	existing: AgentPresenceContext | undefined,
	patch: AgentPresenceContextPatch | undefined,
): AgentPresenceContext | undefined {
	const next: { -readonly [K in keyof AgentPresenceContext]: AgentPresenceContext[K] } = { ...(existing ?? {}) };
	if (patch) {
		for (const key of SCALAR_KEYS) {
			const value = patch[key];
			if (value === undefined) continue;
			if (value.length === 0) delete next[key];
			else next[key] = value;
		}
		for (const key of ARRAY_KEYS) {
			const value = patch[key];
			if (value === undefined) continue;
			if (value.length === 0) delete next[key];
			else next[key] = [...value];
		}
	}
	return isEmptyContext(next) ? undefined : next;
}

export function applyContextDefaults(
	existing: AgentPresenceContext | undefined,
	defaults: AgentPresenceContextPatch | undefined,
): AgentPresenceContextPatch | undefined {
	if (!defaults) return undefined;
	const fill: { -readonly [K in keyof AgentPresenceContext]: AgentPresenceContext[K] } = {};
	for (const key of SCALAR_KEYS) {
		const value = defaults[key];
		if (value && !existing?.[key]) fill[key] = value;
	}
	for (const key of ARRAY_KEYS) {
		const value = defaults[key];
		if (value && value.length > 0 && (existing?.[key]?.length ?? 0) === 0) fill[key] = [...value];
	}
	return Object.keys(fill).length > 0 ? fill : undefined;
}

export function cloneContext(context: AgentPresenceContext | undefined): AgentPresenceContext | undefined {
	if (!context) return undefined;
	return {
		...(context.cwd ? { cwd: context.cwd } : {}),
		...(context.hostname ? { hostname: context.hostname } : {}),
		...(context.title ? { title: context.title } : {}),
		...(context.task ? { task: context.task } : {}),
		...(context.modifiedFiles?.length ? { modifiedFiles: [...context.modifiedFiles] } : {}),
		...(context.resources?.length ? { resources: [...context.resources] } : {}),
	};
}

export function contextFromProject(project: string | undefined): AgentPresenceContextPatch | undefined {
	if (!project) return undefined;
	const clean = sanitizeContextText(redactCredentials(project));
	if (clean.length === 0 || clean.length > PRESENCE_CONTEXT_LIMITS.cwd) return undefined;
	return { cwd: clean };
}
