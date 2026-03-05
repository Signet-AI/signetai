#!/usr/bin/env bun

/**
 * Doc drift detector — compares documentation claims against source truth.
 * Outputs a JSON report to stdout. Exit 0 = no drift, exit 1 = drift found.
 *
 * Usage: bun scripts/doc-drift.ts [--json | --markdown]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function read(relPath: string): string {
	const abs = join(ROOT, relPath);
	if (!existsSync(abs)) {
		console.error(`Error: required file not found: ${relPath}`);
		process.exit(2);
	}
	return readFileSync(abs, "utf8");
}

function fileExists(relPath: string): boolean {
	return existsSync(join(ROOT, relPath));
}

function globDir(dir: string, pattern: RegExp): string[] {
	const absDir = join(ROOT, dir);
	if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return [];
	return readdirSync(absDir).filter((f) => pattern.test(f));
}

function listTsFilesRecursive(dir: string): string[] {
	const absDir = join(ROOT, dir);
	if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return [];

	const files: string[] = [];

	function walk(currentAbs: string, relPrefix: string): void {
		for (const entry of readdirSync(currentAbs)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const nextAbs = join(currentAbs, entry);
			const nextRel = relPrefix ? `${relPrefix}/${entry}` : entry;
			if (!existsSync(nextAbs)) continue; // skip broken symlinks
			const nextStat = statSync(nextAbs);
			if (nextStat.isDirectory()) {
				walk(nextAbs, nextRel);
				continue;
			}
			if (!entry.endsWith(".ts")) continue;
			if (entry.endsWith(".test.ts")) continue;
			files.push(`${dir}/${nextRel}`);
		}
	}

	walk(absDir, "");
	return files.sort();
}

function sliceSection(content: string, heading: string): string {
	const start = content.indexOf(heading);
	if (start === -1) return "";

	const afterStart = content.slice(start + heading.length);
	const nextH2 = afterStart.search(/\n##\s+/);
	const nextSetext = afterStart.search(/\n[^\n]+\n(?:={3,}|-{3,})[ \t]*(?:\n|$)/);
	const boundaries = [nextH2, nextSetext].filter((offset) => offset >= 0);
	const end =
		boundaries.length > 0
			? start + heading.length + Math.min(...boundaries)
			: content.length;

	return content.slice(start, end);
}

/** Normalize a route path for comparison (strip trailing slash, lowercase). */
function normRoute(p: string): string {
	return p.replace(/\/+$/, "").toLowerCase();
}

function routeKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${normRoute(path)}`;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// ---------------------------------------------------------------------------
// 1. Route drift
// ---------------------------------------------------------------------------

interface RouteEntry {
	method: string;
	path: string;
	source: string;
}

function extractRoutesFromSource(): RouteEntry[] {
	const files = [
		"packages/daemon/src/daemon.ts",
		...listTsFilesRecursive("packages/daemon/src/routes"),
		"packages/daemon/src/mcp/route.ts",
	];

	const routePattern =
		/app\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g;

	const routes: RouteEntry[] = [];

	for (const file of files) {
		if (!fileExists(file)) continue;
		const content = read(file);
		routePattern.lastIndex = 0;
		let match: RegExpExecArray | null = null;
		while ((match = routePattern.exec(content)) !== null) {
			const method = match[1].toUpperCase();
			const path = match[2];
			// Skip wildcard middleware paths and static root
			if (path === "*" || path === "/*" || path === "/**" || path === "/")
				continue;
			routes.push({ method, path, source: file });
		}
	}

	// Deduplicate by method+path — the same route can appear in both daemon.ts
	// and a routes file (re-export/remount), which would produce duplicate
	// false positives in missingFromDocs even after the route is documented.
	const seen = new Set<string>();
	return routes.filter((r) => {
		const k = routeKey(r.method, r.path);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

interface DocRoute {
	endpoint: string;
	methods: string[];
}

function parseClaudeMdRoutes(content: string): DocRoute[] {
	const routes: DocRoute[] = [];
	const tablePattern =
		/^\|\s*`([^`]+)`\s*\|\s*([A-Z/]+)\s*\|\s*(.+?)\s*\|$/gm;

	let match: RegExpExecArray | null = null;
	while ((match = tablePattern.exec(content)) !== null) {
		const endpoint = match[1];
		const methodStr = match[2];
		if (endpoint === "Endpoint" || methodStr === "Method") continue;
		const methods = methodStr.split("/").map((m) => m.trim().toUpperCase());
		routes.push({ endpoint, methods });
	}

	return routes;
}

function checkRouteDrift(claudeMd: string): {
	missingFromDocs: RouteEntry[];
	extraInDocs: DocRoute[];
} {
	const sourceRoutes = extractRoutesFromSource();
	const endpointSection = sliceSection(claudeMd, "## HTTP API Endpoints");
	const docRoutes = endpointSection
		? parseClaudeMdRoutes(endpointSection)
		: [];

	// Build a set of documented route keys; expand ALL to specific HTTP methods
	// to mirror source-side expansion so comparison is symmetric.
	const docKeys = new Set<string>();
	for (const dr of docRoutes) {
		for (const m of dr.methods) {
			if (m === "ALL") {
				for (const hm of HTTP_METHODS) docKeys.add(routeKey(hm, dr.endpoint));
			} else {
				docKeys.add(routeKey(m, dr.endpoint));
			}
		}
	}

	// Build a set of source route keys; expand app.all() to all HTTP methods
	// so documented specific-method entries aren't falsely flagged as missing.
	const sourceKeys = new Set<string>();
	for (const sr of sourceRoutes) {
		if (sr.method === "ALL") {
			for (const m of HTTP_METHODS) sourceKeys.add(routeKey(m, sr.path));
		} else {
			sourceKeys.add(routeKey(sr.method, sr.path));
		}
	}

	const missingFromDocs = sourceRoutes.filter((sr) => {
		if (sr.method === "ALL") {
			// An app.all() route is documented if any specific method covers it
			return !HTTP_METHODS.some((m) => docKeys.has(routeKey(m, sr.path)));
		}
		return !docKeys.has(routeKey(sr.method, sr.path));
	});

	const extraInDocs: DocRoute[] = [];
	for (const dr of docRoutes) {
		const missingMethods = dr.methods.filter(
			(m) => !sourceKeys.has(routeKey(m, dr.endpoint)),
		);
		if (missingMethods.length > 0) {
			extraInDocs.push({ endpoint: dr.endpoint, methods: missingMethods });
		}
	}

	return { missingFromDocs, extraInDocs };
}

// ---------------------------------------------------------------------------
// 2. Migration drift
// ---------------------------------------------------------------------------

interface MigrationDrift {
	documentedRanges: { location: string; text: string }[];
	actualFiles: string[];
	actualMax: string;
	hasDrift: boolean;
}

function checkMigrationDrift(claudeMd: string): MigrationDrift {
	const migFiles = globDir("packages/core/src/migrations", /^\d{3}.*\.ts$/)
		.filter((f) => !f.includes(".test.") && f !== "index.ts")
		.sort();

	const actualMax = migFiles.length > 0 ? migFiles[migFiles.length - 1] : "";
	const maxNum = actualMax.match(/^(\d{3})/)?.[1] ?? "000";

	const ranges: { location: string; text: string }[] = [];
	// Bound the scan to the migrations section to avoid false positives from
	// unrelated text elsewhere in CLAUDE.md (e.g. changelogs, step counts).
	const sectionHeader = "## Database Migrations";
	const sectionStart = claudeMd.indexOf(sectionHeader);
	const migSection = sliceSection(claudeMd, sectionHeader) || claudeMd;
	// Compute line offset so reported locations point to the correct file line.
	const lineOffset =
		sectionStart === -1 ? 0 : claudeMd.slice(0, sectionStart).split("\n").length - 1;
	const lines = migSection.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const rangeMatch = line.match(/(\d{3})[\w-]*\s+through\s+(\d{3})[\w-]*/);
		if (rangeMatch) {
			ranges.push({ location: `CLAUDE.md:${lineOffset + i + 1}`, text: rangeMatch[0] });
		}
	}

	const hasDrift =
		ranges.length === 0
			? migFiles.length > 0
			: ranges.some((r) => {
					const endNum = r.text.match(/through\s+(\d{3})/)?.[1];
					return endNum !== maxNum;
				});

	return {
		documentedRanges: ranges,
		actualFiles: migFiles,
		actualMax,
		hasDrift,
	};
}

// ---------------------------------------------------------------------------
// 3. Key files drift
// ---------------------------------------------------------------------------

interface KeyFilesDrift {
	missing: string[];
	total: number;
}

function checkKeyFilesDrift(claudeMd: string): KeyFilesDrift {
	const section = sliceSection(claudeMd, "## Key Files");
	if (!section) return { missing: [], total: 0 };

	const pathPattern = /^[ \t]*- `([^`]+)`/gm;
	const paths: string[] = [];
	let match: RegExpExecArray | null = null;
	while ((match = pathPattern.exec(section)) !== null) {
		paths.push(match[1]);
	}

	const missing = paths.filter((p) => !fileExists(p));

	return { missing, total: paths.length };
}

// ---------------------------------------------------------------------------
// 4. Packages drift
// ---------------------------------------------------------------------------

interface PackageInfo {
	name: string;
	dir: string;
}

function getActualPackages(): PackageInfo[] {
	const packagesDir = join(ROOT, "packages");
	const packages: PackageInfo[] = [];

	function scan(dir: string, relPrefix: string): void {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
			const pkgJson = join(full, "package.json");
			if (existsSync(pkgJson)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
					if (pkg.name) {
						packages.push({ name: pkg.name, dir: `packages/${rel}` });
					}
				} catch {
					// Skip malformed package manifests.
				}
			}
			// Always recurse — a workspace root may have an unnamed package.json
			// but still contain named sub-packages underneath it.
			if (existsSync(full) && statSync(full).isDirectory() && entry !== "node_modules") {
				scan(full, rel);
			}
		}
	}

	scan(packagesDir, "");

	// Check special top-level locations
	for (const extra of ["web", "predictor"]) {
		const pkgJson = join(ROOT, extra, "package.json");
		if (existsSync(pkgJson)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
				if (pkg.name) {
					packages.push({ name: pkg.name, dir: extra });
				}
			} catch {
				// Skip malformed package manifests.
			}
		}
	}

	return packages;
}

interface PackageTableDrift {
	file: string;
	missingFromTable: PackageInfo[];
	extraInTable: string[];
}

function parsePackageTable(
	content: string,
	sectionHeader: string,
): Map<string, string> {
	const tableContent = sliceSection(content, sectionHeader);
	if (!tableContent) return new Map();

	const pkgPattern = /`([^`]+)`/;
	const result = new Map<string, string>();

	for (const line of tableContent.split("\n")) {
		if (!line.startsWith("|") || line.includes("---")) continue;
		const cells = line
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean);
		if (cells.length < 2) continue;
		const nameMatch = cells[0].match(pkgPattern);
		if (nameMatch && nameMatch[1] !== "Package") {
			result.set(nameMatch[1], line);
		}
	}

	return result;
}

function checkPackageDrift(claudeMd: string): PackageTableDrift[] {
	const actual = getActualPackages();
	const actualNames = new Set(actual.map((p) => p.name));

	const results: PackageTableDrift[] = [];

	// CLAUDE.md
	const claudeTable = parsePackageTable(claudeMd, "## Packages");
	results.push({
		file: "CLAUDE.md",
		missingFromTable: actual.filter((p) => !claudeTable.has(p.name)),
		extraInTable: [...claudeTable.keys()].filter(
			(name) => !actualNames.has(name),
		),
	});

	// README.md
	if (fileExists("README.md")) {
		const readme = read("README.md");
		const readmeTable = parsePackageTable(readme, "Packages\n===");
		results.push({
			file: "README.md",
			missingFromTable: actual.filter((p) => !readmeTable.has(p.name)),
			extraInTable: [...readmeTable.keys()].filter(
				(name) => !actualNames.has(name),
			),
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface DriftReport {
	routes: {
		missingFromDocs: RouteEntry[];
		extraInDocs: DocRoute[];
	};
	migrations: MigrationDrift;
	keyFiles: KeyFilesDrift;
	packages: PackageTableDrift[];
	hasDrift: boolean;
	summary: string[];
}

function generateReport(): DriftReport {
	const claudeMd = read("CLAUDE.md");
	const routes = checkRouteDrift(claudeMd);
	const migrations = checkMigrationDrift(claudeMd);
	const keyFiles = checkKeyFilesDrift(claudeMd);
	const packages = checkPackageDrift(claudeMd);

	const summary: string[] = [];

	if (routes.missingFromDocs.length > 0) {
		summary.push(
			`${routes.missingFromDocs.length} route(s) in source but missing from CLAUDE.md`,
		);
	}
	if (routes.extraInDocs.length > 0) {
		summary.push(
			`${routes.extraInDocs.length} route(s) in CLAUDE.md but not found in source`,
		);
	}
	if (migrations.hasDrift) {
		summary.push(
			`Migration range stale: documented max differs from actual (${migrations.actualMax})`,
		);
	}
	if (keyFiles.missing.length > 0) {
		summary.push(
			`${keyFiles.missing.length} key file path(s) in CLAUDE.md don't exist on disk`,
		);
	}
	for (const pkg of packages) {
		if (pkg.missingFromTable.length > 0) {
			summary.push(
				`${pkg.missingFromTable.length} package(s) missing from ${pkg.file} table`,
			);
		}
		if (pkg.extraInTable.length > 0) {
			summary.push(
				`${pkg.extraInTable.length} package(s) in ${pkg.file} table but not on disk`,
			);
		}
	}

	return {
		routes,
		migrations,
		keyFiles,
		packages,
		hasDrift: summary.length > 0,
		summary,
	};
}

function formatMarkdown(report: DriftReport): string {
	const lines: string[] = ["# Doc Drift Report", ""];

	if (!report.hasDrift) {
		lines.push("No drift detected. All documentation is in sync with source.");
		return lines.join("\n");
	}

	lines.push("## Summary", "");
	for (const s of report.summary) {
		lines.push(`- ${s}`);
	}
	lines.push("");

	if (
		report.routes.missingFromDocs.length > 0 ||
		report.routes.extraInDocs.length > 0
	) {
		lines.push("## Route Drift", "");

		if (report.routes.missingFromDocs.length > 0) {
			lines.push("### Missing from CLAUDE.md", "");
			lines.push("| Method | Path | Source File |");
			lines.push("|--------|------|-------------|");
			for (const r of report.routes.missingFromDocs) {
				lines.push(`| ${r.method} | \`${r.path}\` | ${r.source} |`);
			}
			lines.push("");
		}

		if (report.routes.extraInDocs.length > 0) {
			lines.push("### In CLAUDE.md but not in source", "");
			lines.push("| Methods | Endpoint |");
			lines.push("|---------|----------|");
			for (const r of report.routes.extraInDocs) {
				lines.push(`| ${r.methods.join(", ")} | \`${r.endpoint}\` |`);
			}
			lines.push("");
		}
	}

	if (report.migrations.hasDrift) {
		lines.push("## Migration Drift", "");
		lines.push(`Actual latest: \`${report.migrations.actualMax}\``, "");
		for (const r of report.migrations.documentedRanges) {
			lines.push(`- ${r.location}: "${r.text}"`);
		}
		lines.push("");
	}

	if (report.keyFiles.missing.length > 0) {
		lines.push("## Missing Key Files", "");
		for (const f of report.keyFiles.missing) {
			lines.push(`- \`${f}\``);
		}
		lines.push("");
	}

	for (const pkg of report.packages) {
		if (pkg.missingFromTable.length > 0 || pkg.extraInTable.length > 0) {
			lines.push(`## Package Drift (${pkg.file})`, "");
			if (pkg.missingFromTable.length > 0) {
				lines.push("Missing from table:");
				for (const p of pkg.missingFromTable) {
					lines.push(`- \`${p.name}\` (${p.dir})`);
				}
			}
			if (pkg.extraInTable.length > 0) {
				lines.push("In table but not on disk:");
				for (const name of pkg.extraInTable) {
					lines.push(`- \`${name}\``);
				}
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const format = args.includes("--markdown") ? "markdown" : "json";
if (args.some((a) => a.startsWith("--") && a !== "--markdown" && a !== "--json")) {
	console.error(`Unknown flag(s): ${args.filter((a) => a.startsWith("--")).join(", ")}`);
	process.exit(2);
}
const report = generateReport();

if (format === "markdown") {
	console.log(formatMarkdown(report));
} else {
	console.log(JSON.stringify(report, null, 2));
}

process.exit(report.hasDrift ? 1 : 0);
