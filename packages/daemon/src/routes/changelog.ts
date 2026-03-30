/**
 * Changelog and roadmap routes.
 *
 * Fetches project markdown docs from GitHub, renders them to HTML
 * server-side (no client-side markdown library needed), and caches for 5 min.
 * Falls back to local files when GitHub is unreachable.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Hono } from "hono";
import { logger } from "../logger.js";

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/Signet-AI/signetai/main";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const CHANGELOG_MAX_RELEASES = 30;

// Resolve monorepo root relative to this file (dev only; absent in npm installs)
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface CacheEntry {
	html: string;
	source: "github" | "local";
	cachedAt: number;
}

type DocFilename = "CHANGELOG.md" | "ROADMAP.md" | "README.md";

const cache = new Map<string, CacheEntry>();

/** Trim changelog to N most recent release sections. */
function truncateChangelog(content: string, max = CHANGELOG_MAX_RELEASES): string {
	const sections = content.split(/(?=\n## \[)/);
	const header = sections[0] ?? "";
	return header + sections.slice(1, max + 1).join("");
}

function extractReadmeOverview(content: string): string {
	const localFirstMatch = content.match(/Signet is a local-first[\s\S]*?without ever reading their values\./);
	const whyMatch = content.match(/Most AI tools build memory silos\.[\s\S]*?unless you configure it to\./);

	const normalizeParagraph = (text: string): string =>
		text
			.replace(/<\/?[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();

	if (localFirstMatch && whyMatch) {
		return [
			"# Signet",
			"## Own your agent. Bring it anywhere.",
			normalizeParagraph(localFirstMatch[0]),
			"## Why Signet",
			normalizeParagraph(whyMatch[0]),
		].join("\n\n");
	}

	const cleaned = content
		.replace(/<[^>]+>/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("![") && !isShieldBadge(line) && line !== "---");
	const fallback = cleaned.slice(0, 18).join("\n");
	return fallback || "# Signet\n\nSignet overview unavailable.";
}

function isShieldBadge(line: string): boolean {
	return (
		/^!\[[^\]]*]\(https:\/\/img\.shields\.io\/[^)\s]+\)$/.test(line) ||
		/^\[!\[[^\]]*]\(https:\/\/img\.shields\.io\/[^)\s]+\)]\([^)]+\)$/.test(line)
	);
}

/** Minimal markdown → HTML for headings, lists, bold, code, hr. */
function renderMarkdown(md: string): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	const lines = md.split("\n");
	const out: string[] = [];
	let inUl = false;

	const flushList = () => {
		if (inUl) {
			out.push("</ul>");
			inUl = false;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const next = lines[i + 1] ?? "";

		// Setext headings (line followed by === or ---)
		if (/^=+$/.test(next.trim()) && raw.trim()) {
			flushList();
			out.push(`<h1>${esc(raw.trim())}</h1>`);
			i++;
			continue;
		}
		if (/^-{2,}$/.test(next.trim()) && raw.trim() && !raw.startsWith("-")) {
			flushList();
			out.push(`<h2>${esc(raw.trim())}</h2>`);
			i++;
			continue;
		}

		// ATX headings
		const h3 = raw.match(/^### (.+)/);
		if (h3) {
			flushList();
			out.push(`<h3>${esc(h3[1])}</h3>`);
			continue;
		}
		const h2 = raw.match(/^## (.+)/);
		if (h2) {
			flushList();
			out.push(`<h2>${esc(h2[1])}</h2>`);
			continue;
		}
		const h1 = raw.match(/^# (.+)/);
		if (h1) {
			flushList();
			out.push(`<h1>${esc(h1[1])}</h1>`);
			continue;
		}

		// horizontal rule
		if (/^---+$/.test(raw.trim())) {
			flushList();
			out.push("<hr>");
			continue;
		}

		// list item
		const li = raw.match(/^- (.+)/);
		if (li) {
			if (!inUl) {
				out.push("<ul>");
				inUl = true;
			}
			out.push(`<li>${inlineFormat(esc(li[1]))}</li>`);
			continue;
		}

		// blank line
		if (raw.trim() === "") {
			flushList();
			continue;
		}

		// paragraph
		flushList();
		out.push(`<p>${inlineFormat(esc(raw))}</p>`);
	}
	flushList();
	return out.join("\n");
}

/** Bold, italic, inline code, links. */
function inlineFormat(s: string): string {
	return s
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/`(.+?)`/g, "<code>$1</code>")
		.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

async function fetchAndRender(filename: DocFilename): Promise<CacheEntry | null> {
	const now = Date.now();
	const cached = cache.get(filename);
	if (cached && now - cached.cachedAt < CACHE_TTL_MS) return cached;

	let raw: string | null = null;
	let source: "github" | "local" = "github";

	// Try GitHub first
	try {
		const res = await fetch(`${GITHUB_RAW_BASE}/${filename}`, {
			headers: { "User-Agent": "signet-daemon", Accept: "text/plain" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (res.ok) {
			raw = await res.text();
		} else {
			logger.warn("changelog", `GitHub returned ${res.status} for ${filename}`);
		}
	} catch (err) {
		logger.warn("changelog", `GitHub fetch failed for ${filename}`, err as Error);
	}

	// Fall back to local file
	if (!raw) {
		const localPath = join(REPO_ROOT, filename);
		if (existsSync(localPath)) {
			try {
				raw = readFileSync(localPath, "utf-8");
				source = "local";
			} catch (err) {
				logger.warn("changelog", `Local read failed for ${filename}`, err as Error);
			}
		}
	}

	if (!raw) return null;

	const content =
		filename === "CHANGELOG.md" ? truncateChangelog(raw) : filename === "README.md" ? extractReadmeOverview(raw) : raw;
	const html = renderMarkdown(content);
	const entry: CacheEntry = { html, source, cachedAt: now };
	cache.set(filename, entry);
	return entry;
}

export function mountChangelogRoutes(app: Hono): void {
	app.get("/api/changelog", async (c) => {
		try {
			const entry = await fetchAndRender("CHANGELOG.md");
			if (!entry) return c.json({ error: "Changelog unavailable" }, 503);
			return c.json(entry);
		} catch (err) {
			logger.error("changelog", "Failed to serve changelog", err as Error);
			return c.json({ error: "Internal error" }, 500);
		}
	});

	app.get("/api/roadmap", async (c) => {
		try {
			const entry = await fetchAndRender("ROADMAP.md");
			if (!entry) return c.json({ error: "Roadmap unavailable" }, 503);
			return c.json(entry);
		} catch (err) {
			logger.error("changelog", "Failed to serve roadmap", err as Error);
			return c.json({ error: "Internal error" }, 500);
		}
	});

	app.get("/api/readme", async (c) => {
		try {
			const entry = await fetchAndRender("README.md");
			if (!entry) return c.json({ error: "README unavailable" }, 503);
			return c.json(entry);
		} catch (err) {
			logger.error("changelog", "Failed to serve README overview", err as Error);
			return c.json({ error: "Internal error" }, 500);
		}
	});
}
