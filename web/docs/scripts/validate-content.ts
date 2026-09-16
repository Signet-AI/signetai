import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
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

function isWithinRoot(path: string, root: string): boolean {
	const resolvedPath = resolve(path);
	const resolvedRoot = resolve(root);
	return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function assetTargetExists(href: string): boolean {
	const target = href.split(/[?#]/, 1)[0];
	if (!target.startsWith("/assets/")) return true;
	let decodedTarget = target.slice("/assets/".length);
	try {
		decodedTarget = decodeURIComponent(decodedTarget);
	} catch {
		/* keep the literal target */
	}
	return (
		[resolve(ROOT, "public/assets", decodedTarget), resolve(ROOT, "src/assets", decodedTarget)].some(
			(candidate) =>
				isWithinRoot(candidate, join(ROOT, "public/assets")) || isWithinRoot(candidate, join(ROOT, "src/assets")),
		) && [resolve(ROOT, "public/assets", decodedTarget), resolve(ROOT, "src/assets", decodedTarget)].some(isFile)
	);
}

function relativeTargetExists(sourcePath: string, href: string): boolean {
	const target = href.split(/[?#]/, 1)[0];
	if (!target || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return true;
	let decodedTarget = target;
	try {
		decodedTarget = decodeURIComponent(target);
	} catch {
		/* keep the literal target */
	}
	const sourceDirectory = dirname(sourcePath);
	const sourceRouteDirectory = join(
		sourceDirectory,
		sourcePath.slice(sourcePath.lastIndexOf(sep) + 1).replace(/\.mdx?$/, ""),
	);
	const targetPath = decodedTarget.replace(/\/+$/, "");
	const pageCandidates = (base: string) => [
		`${base}.md`,
		`${base}.mdx`,
		join(base, "index.md"),
		join(base, "index.mdx"),
	];
	const candidates = [
		...pageCandidates(resolve(sourceDirectory, targetPath)),
		...pageCandidates(resolve(sourceRouteDirectory, targetPath)),
		resolve(ROOT, "public/assets", targetPath),
		resolve(ROOT, "src/assets", targetPath),
		...(targetPath === ".github/workflows/promote-release.yml" ? [resolve(REPO, targetPath)] : []),
	];
	return candidates.some((candidate) => {
		const isPage = extname(candidate).toLowerCase() === ".md" || extname(candidate).toLowerCase() === ".mdx";
		const approved =
			isWithinRoot(candidate, CONTENT) ||
			isWithinRoot(candidate, join(ROOT, "public/assets")) ||
			isWithinRoot(candidate, join(ROOT, "src/assets")) ||
			candidate === resolve(REPO, ".github/workflows/promote-release.yml");
		return approved && isFile(candidate) && (isPage || extname(candidate) !== "");
	});
}

function checkSidebarStructure(config: string, routes: Set<string>, errors: string[]): void {
	const sidebarStart = config.search(/\bsidebar\s*:\s*\[/);
	let sidebarEnd = -1;
	if (sidebarStart >= 0) {
		const opening = config.indexOf("[", sidebarStart);
		let depth = 0;
		for (let index = opening; index < config.length; index += 1) {
			if (config[index] === "[") depth += 1;
			if (config[index] === "]" && --depth === 0) {
				sidebarEnd = index;
				break;
			}
		}
	}
	const sidebar = sidebarStart >= 0 && sidebarEnd >= 0 ? config.slice(sidebarStart, sidebarEnd) : "";
	const expectedGroups = ["Use Signet", "Operate Signet", "Build with Signet"];
	const groupMatches = [...sidebar.matchAll(/^(\s*)label\s*:\s*["']([^"']+)["']/gm)];
	const minimumIndent = groupMatches.length > 0 ? Math.min(...groupMatches.map((match) => match[1].length)) : -1;
	const topLevelGroups = groupMatches.filter((match) => match[1].length === minimumIndent).map((match) => match[2]);
	if (
		topLevelGroups.length !== expectedGroups.length ||
		topLevelGroups.some((group, index) => group !== expectedGroups[index])
	) {
		errors.push(`Sidebar top-level groups must be exactly: ${expectedGroups.join(", ")}`);
	}

	const ownedRoutes = new Map<string, string[]>();
	let group = "";
	for (const line of sidebar.split("\n")) {
		const indentation = line.match(/^(\s*)/)?.[1].length ?? 0;
		const label = line.match(/label\s*:\s*(["'])(.*?)\1/)?.[2];
		if (label && indentation === minimumIndent) group = label;
		const slug = line.match(/slug\s*:\s*(["'])(.*?)\1/)?.[2];
		if (slug) {
			const route = normalizeRoute(`/${slug}`);
			const owners = ownedRoutes.get(route) ?? [];
			owners.push(group || "<no top-level group>");
			ownedRoutes.set(route, owners);
		}
	}
	for (const route of routes) {
		if (route !== "/" && (ownedRoutes.get(route)?.length ?? 0) !== 1) {
			errors.push(`Public route must appear exactly once in the sidebar hierarchy: ${route}`);
		}
	}
	for (const [route, owners] of ownedRoutes) {
		if (!routes.has(route)) errors.push(`Sidebar points to a missing public route: ${route}`);
		if (owners.length !== 1) errors.push(`Sidebar contains duplicate slug: ${route}`);
		if (!expectedGroups.includes(owners[0])) errors.push(`Sidebar route has no valid top-level owner: ${route}`);
	}
}

function stripCode(source: string): string {
	return source.replace(/```[\s\S]*?```|`[^`\n]+`/g, "");
}

function checkAudienceCoverage(routes: Set<string>, errors: string[]): void {
	const groups = {
		"getting-started": ["/quickstart/", "/getting-started/install/", "/getting-started/setup/"],
		users: ["/memory/", "/sources/", "/documents/", "/configuration/"],
		developers: ["/api/", "/sdk/", "/architecture/", "/harnesses/"],
	};
	for (const [group, required] of Object.entries(groups)) {
		const missing = required.filter((route) => !routes.has(route));
		if (missing.length > 0) errors.push(`Audience group ${group} is missing routes: ${missing.join(", ")}`);
	}
}

function checkGeneratedPages(errors: string[]): void {
	const result = spawnSync("bun", ["scripts/sync-root-docs.ts", "--check"], { cwd: REPO, encoding: "utf8" });
	if (result.status !== 0) errors.push(`Generated docs are out of sync: ${(result.stderr || result.stdout).trim()}`);
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
	const filesByRoute = new Map<string, string[]>();
	for (const path of contentFiles) {
		const route = routeFor(path);
		const files = filesByRoute.get(route) ?? [];
		files.push(relative(CONTENT, path).split(sep).join("/"));
		filesByRoute.set(route, files);
	}
	for (const [route, files] of filesByRoute) {
		if (files.length > 1) errors.push(`Duplicate public route ${route} is generated by: ${files.join(", ")}`);
	}
	const routes = new Set(filesByRoute.keys());

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
			if (href.startsWith("/") && !href.startsWith("//")) {
				if (href.startsWith("/assets/")) {
					if (!assetTargetExists(href)) errors.push(`${rel}: unresolved asset link ${href}`);
				} else {
					const route = normalizeRoute(href);
					if (!routes.has(route)) errors.push(`${rel}: unresolved internal route ${href}`);
				}
			} else if (!href.startsWith("/") && !relativeTargetExists(path, href)) {
				errors.push(`${rel}: unresolved relative link ${href}`);
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
	checkSidebarStructure(config, routes, errors);
	checkAudienceCoverage(routes, errors);
	checkGeneratedPages(errors);

	if (errors.length > 0) {
		console.error("Docs content validation failed:");
		for (const error of errors) console.error(`- ${error}`);
		return 1;
	}

	console.log(`Validated ${contentFiles.length} public docs pages and ${routes.size} routes.`);
	return 0;
}

process.exit(main());
