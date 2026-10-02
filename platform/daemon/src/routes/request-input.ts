import type { Context } from "hono";

export function parseOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return undefined;
	}
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (lower === "1" || lower === "true") return true;
		if (lower === "0" || lower === "false") return false;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export async function readOptionalJsonObject(c: Context): Promise<Record<string, unknown> | null> {
	const raw = await c.req.text();
	if (!raw.trim()) return {};
	try {
		return toRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}
