/** Shared utilities for marketplace and skill card rendering. */

const MONOGRAM_COLORS = [
	"var(--sig-icon-bg-1)",
	"var(--sig-icon-bg-2)",
	"var(--sig-icon-bg-3)",
	"var(--sig-icon-bg-4)",
	"var(--sig-icon-bg-5)",
	"var(--sig-icon-bg-6)",
] as const;

/** Simple string hash used for deterministic color assignment. */
function hash(name: string): number {
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
	return h;
}

/** Two-letter monogram from a display name (splits on separators). */
export function getMonogram(name: string): string {
	const parts = name.split(/[-_.\s]+/).filter(Boolean);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

/** Deterministic background color for a card monogram. */
export function getMonogramBg(name: string): string {
	return MONOGRAM_COLORS[Math.abs(hash(name)) % MONOGRAM_COLORS.length] ?? MONOGRAM_COLORS[0];
}

/**
 * Derive a GitHub org avatar URL from a source URL.
 * Returns null for non-GitHub URLs.
 */
export function getAvatarUrl(sourceUrl: string | undefined): string | null {
	if (!sourceUrl) return null;
	const match = sourceUrl.match(/^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9._-]+)/);
	if (match?.[1]) return `https://github.com/${match[1]}.png?size=40`;
	return null;
}

/**
 * Derive a GitHub org avatar from a catalog source and catalogId.
 * For "modelcontextprotocol/servers" uses the org from source.
 * For "github" source uses the org from the catalogId (org/repo).
 */
export function getAvatarFromSource(source: string | undefined, catalogId: string | undefined): string | null {
	if (!source) return null;
	if (source === "modelcontextprotocol/servers") return "https://github.com/modelcontextprotocol.png?size=40";
	if (source === "github" && catalogId?.includes("/")) return `https://github.com/${catalogId.split("/")[0]}.png?size=40`;
	return null;
}
