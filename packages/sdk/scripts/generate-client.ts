#!/usr/bin/env bun
/**
 * SDK Code Generator
 *
 * Parses daemon.ts routes and generates SDK client methods.
 * Run: bun run scripts/generate-client.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(__dirname, "../../daemon/src/daemon.ts");
const OUTPUT_DIR = join(__dirname, "../src/generated");

type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

interface Route {
	readonly method: RouteMethod;
	readonly path: string;
	readonly line: number;
}

/**
 * Extract all routes from daemon.ts
 */
function extractRoutes(daemonCode: string): readonly Route[] {
	const routes: Route[] = [];
	const lines = daemonCode.split("\n");

	// Match patterns like: app.get("/path", ...), app.delete("/path", ...)
	const routeRegex = /^\s*app\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/;

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(routeRegex);
		if (!match) {
			continue;
		}
		const [, method, path] = match;
		routes.push({
			method: method as RouteMethod,
			path,
			line: i + 1,
		});
	}

	return routes;
}

function toPascalCase(segment: string): string {
	const cleaned = segment.replace(/^:+/, "");
	const parts = cleaned.split(/[-_]+/g).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return "Unknown";
	}
	return parts
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function toMethodName(route: Route): string {
	const segments = route.path.split("/").filter(Boolean);
	const methodPrefix = route.method === "delete" ? "delete" : route.method;
	const suffix = segments
		.map((segment) => {
			if (segment.startsWith(":")) {
				return `By${toPascalCase(segment.slice(1))}`;
			}
			return toPascalCase(segment);
		})
		.join("");
	const raw = `${methodPrefix}${suffix}`;
	return raw.charAt(0).toLowerCase() + raw.slice(1);
}

/**
 * Extract path parameters from route
 * Example: /api/tasks/:id → ["id"]
 */
function extractParams(path: string): readonly string[] {
	const params: string[] = [];
	const regex = /:([a-zA-Z_]+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(path)) !== null) {
		params.push(match[1]);
	}
	return params;
}

/**
 * Build a unique method name for each route.
 */
function buildMethodNames(routes: readonly Route[]): readonly string[] {
	const used = new Map<string, number>();
	return routes.map((route) => {
		const baseName = toMethodName(route);
		const seen = used.get(baseName) ?? 0;
		used.set(baseName, seen + 1);
		if (seen === 0) {
			return baseName;
		}
		return `${baseName}${seen + 1}`;
	});
}

/**
 * Generate TypeScript method for a route.
 */
function generateMethod(route: Route, methodName: string): string {
	const params = extractParams(route.path);

	const paramList: string[] = [];
	for (const param of params) {
		paramList.push(`${param}: string`);
	}

	if (route.method === "post" || route.method === "patch" || route.method === "put") {
		paramList.push("opts?: Record<string, unknown>");
	}

	if (route.method === "get" || route.method === "delete") {
		paramList.push("query?: Record<string, unknown>");
	}

	const signature = `${methodName}(${paramList.join(", ")}): Promise<unknown>`;

	let urlPath = route.path;
	for (const param of params) {
		urlPath = urlPath.replace(`:${param}`, `\${${param}}`);
	}
	const url = params.length > 0 ? `\`${urlPath}\`` : `"${urlPath}"`;

	let body = "";
	if (route.method === "get") {
		body = `return this.transport.get<unknown>(${url}, query);`;
	} else if (route.method === "delete") {
		body = `return this.transport.del<unknown>(${url}, query);`;
	} else if (route.method === "post") {
		body = `return this.transport.post<unknown>(${url}, opts);`;
	} else if (route.method === "patch") {
		body = `return this.transport.patch<unknown>(${url}, opts);`;
	} else {
		body = `return this.transport.put<unknown>(${url}, opts);`;
	}

	return `  async ${signature} {\n    ${body}\n  }`;
}

/**
 * Generate the full client file.
 */
function generateClient(routes: readonly Route[]): string {
	const methodNames = buildMethodNames(routes);
	const methods = routes
		.map((route, index) => generateMethod(route, methodNames[index]))
		.join("\n\n");

	return `/**
 * AUTO-GENERATED FILE — DO NOT EDIT
 * Generated from daemon.ts routes by scripts/generate-client.ts
 *
 * This file provides broad coverage of daemon endpoints.
 * Manual helpers live in ../helpers.ts
 */

export class GeneratedClient {
  constructor(
    private readonly transport: {
      readonly get: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
      readonly post: <T>(path: string, body?: unknown) => Promise<T>;
      readonly put: <T>(path: string, body?: unknown) => Promise<T>;
      readonly patch: <T>(path: string, body?: unknown) => Promise<T>;
      readonly del: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
    },
  ) {}

${methods}
}
`;
}

/**
 * Main
 */
function main(): void {
	console.log("Reading daemon.ts...");
	const daemonCode = readFileSync(DAEMON_PATH, "utf-8");

	console.log("Extracting routes...");
	const routes = extractRoutes(daemonCode);
	console.log(`Found ${routes.length} routes`);

	console.log("Generating client...");
	const clientCode = generateClient(routes);

	if (!existsSync(OUTPUT_DIR)) {
		mkdirSync(OUTPUT_DIR, { recursive: true });
	}

	const outputPath = join(OUTPUT_DIR, "client.ts");
	console.log(`Writing to ${outputPath}...`);
	writeFileSync(outputPath, clientCode, "utf-8");

	console.log("✓ Generated SDK client methods for all daemon routes");
	console.log(`  Total methods: ${routes.length}`);
}

main();
