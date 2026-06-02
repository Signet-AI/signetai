#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const manifestPath = join(repoRoot, "platform/daemon-rs/contracts/route-parity.json");

const routeMethods = ["get", "post", "put", "delete", "patch", "all"] as const;
type RouteMethod = (typeof routeMethods)[number];
type Status =
	| "native-rust-replay-proven"
	| "native-rust-unit-only"
	| "mounted-shallow"
	| "missing"
	| "deprecated-remove-from-ts-too";

type Route = {
	readonly method: Uppercase<RouteMethod>;
	readonly path: string;
	readonly file: string;
	readonly line: number;
};

type ReplayedRoute = {
	readonly method: string;
	readonly path: string;
};

type ManifestRoute = Route & {
	readonly status: Status;
	readonly rustMounted: boolean;
	readonly contractReplay: boolean;
	readonly parityRule: boolean;
};

type Manifest = {
	readonly generatedBy: string;
	readonly statusLegend: Record<Status, string>;
	readonly summary: Record<string, number>;
	readonly routes: readonly ManifestRoute[];
};

function read(path: string): string {
	return readFileSync(path, "utf8");
}

function lineNumber(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i += 1) {
		if (source.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

function listFiles(dir: string, predicate: (path: string) => boolean): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFiles(path, predicate));
		} else if (predicate(path)) {
			out.push(path);
		}
	}
	return out;
}

function normalizeTsPath(path: string): string {
	return path.replace(/:([A-Za-z0-9_]+)\{[^}]+\}/g, ":$1").split("?")[0];
}

function normalizeRustPath(path: string): string {
	return path.replace(/\{([^}/]+)\}/g, ":$1");
}

function routeShape(path: string): string {
	return normalizeTsPath(normalizeRustPath(path))
		.split("/")
		.map((part) => (part.startsWith(":") ? ":param" : part))
		.join("/");
}

function routeKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${routeShape(path)}`;
}

function pathMatches(pattern: string, candidate: string): boolean {
	const patternParts = normalizeTsPath(pattern).split("/");
	const candidateParts = normalizeTsPath(candidate).split("/");
	if (patternParts.length !== candidateParts.length) return false;
	return patternParts.every((part, index) => part.startsWith(":") || part === candidateParts[index]);
}

function extractTsRoutes(): Route[] {
	const files = [
		join(repoRoot, "platform/daemon/src/daemon.ts"),
		...listFiles(join(repoRoot, "platform/daemon/src/routes"), (path) => path.endsWith(".ts") && !path.endsWith(".test.ts")),
		...listFiles(join(repoRoot, "platform/daemon/src/mcp"), (path) => path.endsWith(".ts") && !path.endsWith(".test.ts")),
	];
	const routes = new Map<string, Route>();
	const routeCall = /\bapp\.(get|post|put|delete|patch|all)\(\s*["`]([^"`]+)["`]/g;

	for (const file of files.filter(existsSync)) {
		const source = read(file);
		for (const match of source.matchAll(routeCall)) {
			const method = match[1].toUpperCase() as Uppercase<RouteMethod>;
			const path = normalizeTsPath(match[2]);
			const key = `${method} ${path}`;
			if (routes.has(key)) continue;
			routes.set(key, {
				method,
				path,
				file: relative(repoRoot, file),
				line: lineNumber(source, match.index ?? 0),
			});
		}
	}

	return [...routes.values()].sort(compareRoutes);
}

function findMatchingParen(source: string, openIndex: number): number {
	let depth = 0;
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	for (let i = openIndex; i < source.length; i += 1) {
		const ch = source[i];
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") depth += 1;
		if (ch === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	throw new Error(`unclosed route call at byte ${openIndex}`);
}

function extractRustRoutes(): Set<string> {
	const source = read(join(repoRoot, "platform/daemon-rs/crates/signet-daemon/src/main.rs"));
	const mounted = new Set<string>();
	const callStart = ".route(";
	let index = 0;

	while (true) {
		const start = source.indexOf(callStart, index);
		if (start === -1) break;
		const open = start + callStart.length - 1;
		const close = findMatchingParen(source, open);
		const body = source.slice(open + 1, close);
		const pathMatch = body.match(/^\s*"([^"]+)"/);
		if (!pathMatch) {
			index = close + 1;
			continue;
		}
		const path = normalizeRustPath(pathMatch[1]);
		for (const method of routeMethods) {
			const re = new RegExp(`(?:^|[.\\s:])${method}\\s*\\(`, "i");
			if (re.test(body)) {
				mounted.add(routeKey(method, path));
			}
		}
		index = close + 1;
	}

	return mounted;
}

function extractContractReplayRoutes(): ReplayedRoute[] {
	const source = read(join(repoRoot, "platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs"));
	const replayed: ReplayedRoute[] = [];
	const call = /\bserver\s*\.\s*(get|post|patch|delete|put)(?:_bearer)?\s*\(\s*(?:\n\s*)?"([^"]+)"/g;
	for (const match of source.matchAll(call)) {
		replayed.push({ method: match[1].toUpperCase(), path: normalizeTsPath(match[2]) });
	}
	return replayed;
}

function extractParityRules(): Set<string> {
	const rulesPath = join(repoRoot, "platform/daemon-rs/contracts/parity-rules.json");
	const parsed = JSON.parse(read(rulesPath)) as { rules?: { endpoints?: Record<string, unknown> } };
	const endpoints = parsed.rules?.endpoints ?? {};
	return new Set(Object.keys(endpoints).map((key) => {
		const [method, ...pathParts] = key.split(" ");
		return routeKey(method, pathParts.join(" "));
	}));
}

function classify(rustMounted: boolean, contractReplay: boolean, parityRule: boolean): Status {
	if (!rustMounted) return "missing";
	if (contractReplay) return "native-rust-replay-proven";
	if (parityRule) return "native-rust-unit-only";
	return "mounted-shallow";
}

function compareRoutes(a: Route, b: Route): number {
	return a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
}

function buildManifest(): Manifest {
	const rustRoutes = extractRustRoutes();
	const replayedRoutes = extractContractReplayRoutes();
	const parityRules = extractParityRules();
	const routes = extractTsRoutes().map((route): ManifestRoute => {
		const key = routeKey(route.method, route.path);
		const rustMounted = rustRoutes.has(key) || (route.method === "ALL" && rustRoutes.has(routeKey("post", route.path)));
		const contractReplay = replayedRoutes.some(
			(replayed) =>
				(replayed.method === route.method || (route.method === "ALL" && replayed.method === "POST")) &&
				pathMatches(route.path, replayed.path),
		);
		const parityRule = parityRules.has(key);
		return {
			...route,
			status: classify(rustMounted, contractReplay, parityRule),
			rustMounted,
			contractReplay,
			parityRule,
		};
	});
	const summary: Record<string, number> = {};
	for (const route of routes) {
		summary[route.status] = (summary[route.status] ?? 0) + 1;
	}
	return {
		generatedBy: "bun scripts/check-rust-daemon-parity.ts --write",
		statusLegend: {
			"native-rust-replay-proven": "Mounted by daemon-rs and exercised by contract_replay.rs.",
			"native-rust-unit-only": "Mounted by daemon-rs and covered by parity-rules.json, but not yet replayed end to end.",
			"mounted-shallow": "Mounted by daemon-rs without replay evidence or endpoint-specific parity rules.",
			missing: "Public TypeScript daemon route is not mounted by daemon-rs.",
			"deprecated-remove-from-ts-too": "Route is intentionally unsupported and must be removed or hidden from both daemons.",
		},
		summary,
		routes,
	};
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

const args = new Set(Bun.argv.slice(2));
const manifest = buildManifest();
const next = stableJson(manifest);

if (args.has("--write")) {
	writeFileSync(manifestPath, next);
	console.log(`wrote ${relative(repoRoot, manifestPath)} (${manifest.routes.length} routes)`);
	process.exit(0);
}

const current = existsSync(manifestPath) ? read(manifestPath) : "";
if (current !== next) {
	console.error(`${relative(repoRoot, manifestPath)} is stale.`);
	console.error("Run: bun scripts/check-rust-daemon-parity.ts --write");
	process.exit(1);
}

console.log(`rust daemon route parity manifest is current (${manifest.routes.length} routes)`);
