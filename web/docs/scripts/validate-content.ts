import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd());
const CONTENT = join(ROOT, "src/content/docs");
const REPO = resolve(ROOT, "../..");

const PUBLIC_SOURCE_PATHS = [
	"ANALYTICS.md",
	"API.md",
	"ARCHITECTURE.md",
	"AUTH.md",
	"BENCHMARKING.md",
	"CLI.md",
	"CONFIGURATION.md",
	"CONNECTORS.md",
	"CONTRIBUTING.md",
	"DAEMON.md",
	"DASHBOARD.md",
	"DIAGNOSTICS.md",
	"DOCUMENTS.md",
	"FIRST-PR.md",
	"HARNESSES.md",
	"HOOKS.md",
	"KNOWLEDGE-ARCHITECTURE.md",
	"KNOWLEDGE-GRAPH.md",
	"MCP.md",
	"MEMORY-SKILLS.md",
	"MEMORY.md",
	"NORTH-STAR-ONTOLOGY.md",
	"PIPELINE.md",
	"PROCEDURAL-MEMORY.md",
	"QUICKSTART.md",
	"REMOTE-CONNECTORS.md",
	"ROADMAP.md",
	"SCHEDULING.md",
	"SDK.md",
	"SECRETS.md",
	"SELF-HOSTING.md",
	"SKILLS.md",
	"SOURCES.md",
	"UPGRADING.md",
	"WHAT-IS-SIGNET.md",
	"ai-memory-hermes-openclaw.md",
	"api/core-configuration.md",
	"api/documents-sources.md",
	"api/health-status.md",
	"api/inference.md",
	"api/knowledge-ontology.md",
	"api/memory.md",
	"api/operations.md",
	"api/route-inventory.md",
	"api/runtime-extensions.md",
	"api/sessions-hooks.md",
	"api/telemetry-logs.md",
] as const;

function filesUnder(dir: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...filesUnder(path));
		else files.push(path);
	}
	return files;
}

function routeFor(path: string): string {
	const rel = relative(CONTENT, path)
		.split(sep)
		.join("/")
		.replace(/\.mdx?$/, "");
	if (rel === "index") return "/";
	return `/${rel.replace(/\/index$/, "")}/`;
}

function normalizeRoute(href: string): string {
	if (href === "/") return href;
	return `/${href.replace(/^\/+|\/+$/g, "")}/`;
}

function stripCode(source: string): string {
	return source.replace(/```[\s\S]*?```|`[^`\n]+`/g, "");
}

function linksToRetiredDocsOrigin(source: string): boolean {
	for (const match of source.matchAll(/https?:\/\/[^\s)<>'"]+/g)) {
		try {
			const url = new URL(match[0]);
			if (url.protocol === "https:" && url.hostname === "signetai.sh") {
				if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) return true;
			}
		} catch {
			// Ignore malformed URL-shaped prose; Markdown link validation handles local targets below.
		}
	}
	return false;
}

function main(): number {
	const errors: string[] = [];
	const contentFiles = filesUnder(CONTENT).filter((path) => [".md", ".mdx"].includes(extname(path)));
	const routes = new Set(contentFiles.map(routeFor));

	for (const oldPath of PUBLIC_SOURCE_PATHS) {
		if (existsSync(join(REPO, "docs", oldPath))) {
			errors.push(`Public source still exists under root docs/: ${oldPath}`);
		}
	}

	for (const path of contentFiles) {
		const rel = relative(CONTENT, path).split(sep).join("/");
		const source = readFileSync(path, "utf8");
		const prose = stripCode(source);

		if (!source.startsWith("---\n")) errors.push(`${rel}: missing frontmatter`);
		if (linksToRetiredDocsOrigin(source)) errors.push(`${rel}: links to the retired docs origin`);
		if (/\[\[[^\]]+\]\]/.test(prose)) errors.push(`${rel}: contains an unresolved wikilink`);
		if (/^(?:<<<<<<<|=======|>>>>>>>)(?: .*)?$/m.test(source)) {
			errors.push(`${rel}: contains an unresolved merge-conflict marker`);
		}

		const links = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
		let match = links.exec(prose);
		while (match) {
			const href = match[1]?.trim().split("#", 1)[0] ?? "";
			if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/assets/")) {
				const route = normalizeRoute(href);
				if (!routes.has(route)) errors.push(`${rel}: unresolved internal route ${href}`);
			}
			match = links.exec(prose);
		}
	}

	const required = [
		"/quickstart/",
		"/configuration/",
		"/cli/",
		"/api/",
		"/sdk/",
		"/architecture/",
		"/harnesses/",
		"/getting-started/install/",
		"/api/memory/recall-search/",
	];
	for (const route of required) {
		if (!routes.has(route)) errors.push(`Required route is missing: ${route}`);
	}

	const config = readFileSync(join(ROOT, "astro.config.mjs"), "utf8");
	const sidebarRoutes = new Set<string>();
	const slugPattern = /slug:\s*"([^"]+)"/g;
	let slugMatch = slugPattern.exec(config);
	while (slugMatch !== null) {
		sidebarRoutes.add(normalizeRoute(`/${slugMatch[1]}`));
		slugMatch = slugPattern.exec(config);
	}
	for (const route of routes) {
		if (route !== "/" && !sidebarRoutes.has(route)) errors.push(`Public route is missing from the sidebar: ${route}`);
	}
	for (const route of sidebarRoutes) {
		if (!routes.has(route)) errors.push(`Sidebar points to a missing public route: ${route}`);
	}

	if (errors.length > 0) {
		console.error("Docs content validation failed:");
		for (const error of errors) console.error(`- ${error}`);
		return 1;
	}

	console.log(`Validated ${contentFiles.length} public docs pages and ${routes.size} routes.`);
	return 0;
}

process.exit(main());
