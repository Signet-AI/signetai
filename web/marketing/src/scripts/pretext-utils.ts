// Shared pretext utilities: font resolution, caching, font-ready gating.

import type { PreparedText, PreparedTextWithSegments } from "@chenglou/pretext";

type FontRole = "display" | "body" | "mono";

const FONT_FAMILIES: Record<FontRole, string> = {
	display: '"Chakra Petch", sans-serif',
	body: '"Inter", system-ui, sans-serif',
	mono: '"IBM Plex Mono", monospace',
};

export function resolveSiteFont(role: FontRole, size: number, weight = 400): string {
	return `${weight} ${size}px ${FONT_FAMILIES[role]}`;
}

const cache = new Map<string, PreparedText | PreparedTextWithSegments>();
let mod: typeof import("@chenglou/pretext") | null = null;
let fontsReady = false;

async function load(): Promise<typeof import("@chenglou/pretext")> {
	if (mod) return mod;
	mod = await import("@chenglou/pretext");
	return mod;
}

async function ensureFonts(): Promise<void> {
	if (fontsReady) return;
	await document.fonts.ready;
	fontsReady = true;
}

export async function prepareText(text: string, font: string): Promise<PreparedText> {
	const key = `${font}::${text}`;
	const hit = cache.get(key);
	if (hit) return hit as PreparedText;

	const pt = await load();
	await ensureFonts();
	const prepared = pt.prepare(text, font);
	cache.set(key, prepared);
	return prepared;
}

export async function prepareTextWithSegments(text: string, font: string): Promise<PreparedTextWithSegments> {
	const key = `seg::${font}::${text}`;
	const hit = cache.get(key);
	if (hit) return hit as PreparedTextWithSegments;

	const pt = await load();
	await ensureFonts();
	const prepared = pt.prepareWithSegments(text, font);
	cache.set(key, prepared);
	return prepared;
}

export async function layoutText(
	prepared: PreparedText,
	maxWidth: number,
	lineHeight: number,
): Promise<{ height: number; lineCount: number }> {
	const pt = await load();
	return pt.layout(prepared, maxWidth, lineHeight);
}

export async function layoutTextWithLines(
	prepared: PreparedTextWithSegments,
	maxWidth: number,
	lineHeight: number,
): Promise<{ height: number; lineCount: number; lines: Array<{ text: string; width: number }> }> {
	const pt = await load();
	return pt.layoutWithLines(prepared, maxWidth, lineHeight);
}

export async function layoutNextLine(
	prepared: PreparedTextWithSegments,
	cursor: { segmentIndex: number; graphemeIndex: number },
	maxWidth: number,
): Promise<{
	text: string;
	width: number;
	start: { segmentIndex: number; graphemeIndex: number };
	end: { segmentIndex: number; graphemeIndex: number };
} | null> {
	const pt = await load();
	return pt.layoutNextLine(prepared, cursor, maxWidth);
}

export function clearPretextCache(): void {
	cache.clear();
	fontsReady = false;
}
