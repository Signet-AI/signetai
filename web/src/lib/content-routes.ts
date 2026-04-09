import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DOCS_ROOT = resolve(ROOT, "..", "docs");
const BLOG_ROOT = resolve(ROOT, "src", "content", "blog");
const REPO_BLOB_BASE = "https://github.com/Signet-AI/signetai/blob/main";

interface ContentTarget {
	readonly collection: "docs" | "blog";
	readonly slug: string;
	readonly url: string;
}

function listFilesRecursive(dir: string, exts: readonly string[]): string[] {
	const files: string[] = [];

	for (const name of readdirSync(dir)) {
		const abs = join(dir, name);
		const stat = statSync(abs);
		if (stat.isDirectory()) {
			files.push(...listFilesRecursive(abs, exts));
			continue;
		}
		if (exts.some((ext) => name.endsWith(ext))) files.push(abs);
	}

	return files.sort();
}

function normalizeSlug(relPath: string): string {
	return relPath
		.replace(/\.(md|mdx)$/i, "")
		.replace(/\\/g, "/")
		.toLowerCase();
}

const DOC_ROUTE_MAP = new Map(
	listFilesRecursive(DOCS_ROOT, [".md", ".mdx"]).map((abs) => {
		const rel = relative(DOCS_ROOT, abs).replace(/\\/g, "/");
		const slug = normalizeSlug(rel);
		return [slug, { collection: "docs", slug, url: `/docs/${slug}/` } satisfies ContentTarget];
	}),
);

const BLOG_ROUTE_MAP = new Map(
	listFilesRecursive(BLOG_ROOT, [".md", ".mdx"]).map((abs) => {
		const rel = relative(BLOG_ROOT, abs).replace(/\\/g, "/");
		const slug = normalizeSlug(rel);
		return [slug, { collection: "blog", slug, url: `/blog/${slug}/` } satisfies ContentTarget];
	}),
);

function resolveWithinContent(absPath: string): ContentTarget | undefined {
	const relDocs = relative(DOCS_ROOT, absPath);
	if (!relDocs.startsWith("..")) {
		return DOC_ROUTE_MAP.get(normalizeSlug(relDocs));
	}

	const relBlog = relative(BLOG_ROOT, absPath);
	if (!relBlog.startsWith("..")) {
		return BLOG_ROUTE_MAP.get(normalizeSlug(relBlog));
	}

	return undefined;
}

function splitHref(href: string): {
	readonly path: string;
	readonly suffix: string;
} {
	const hashIndex = href.indexOf("#");
	if (hashIndex < 0) return { path: href, suffix: "" };
	return {
		path: href.slice(0, hashIndex),
		suffix: href.slice(hashIndex),
	};
}

function toPosixPath(absPath: string): string {
	return relative(resolve(ROOT, ".."), absPath).replace(/\\/g, "/");
}

export function resolveWikilinkTarget(raw: string): ContentTarget | undefined {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/\.mdx?$/, "");

	if (normalized.startsWith("docs/")) {
		return DOC_ROUTE_MAP.get(normalized.slice(5));
	}
	if (normalized.startsWith("blog/")) {
		return BLOG_ROUTE_MAP.get(normalized.slice(5));
	}

	return DOC_ROUTE_MAP.get(normalized) ?? BLOG_ROUTE_MAP.get(normalized);
}

export function rewriteMarkdownHref(rawHref: string, filePath?: string): string | undefined {
	if (
		!rawHref ||
		rawHref.startsWith("#") ||
		rawHref.startsWith("http://") ||
		rawHref.startsWith("https://") ||
		rawHref.startsWith("mailto:")
	) {
		return undefined;
	}

	const { path, suffix } = splitHref(rawHref);
	if (!path.endsWith(".md") && !path.endsWith(".mdx")) return undefined;
	if (!filePath) return undefined;

	const baseDir = statSync(filePath).isDirectory() ? filePath : dirname(filePath);
	const absTarget = resolve(baseDir, path);
	const contentTarget = resolveWithinContent(absTarget);
	if (contentTarget) return `${contentTarget.url}${suffix}`;

	return `${REPO_BLOB_BASE}/${toPosixPath(absTarget)}${suffix}`;
}

export { BLOG_ROUTE_MAP, DOC_ROUTE_MAP };
