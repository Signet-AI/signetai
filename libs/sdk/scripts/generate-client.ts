#!/usr/bin/env bun
/** Generate SDK methods from the checked-in native HTTP route contract. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(DIR, "../src/generated/client.ts");
export type Method = "get" | "post" | "put" | "patch" | "delete";
export interface Route {
	readonly method: Method;
	readonly path: string;
}
export function loadRoutes(): readonly Route[] {
	const routes = JSON.parse(readFileSync(join(DIR, "routes.json"), "utf8")) as Route[];
	if (!Array.isArray(routes) || routes.length === 0) throw new Error("Native route contract is empty");
	return routes;
}
function pascal(value: string): string {
	return (
		value
			.replace(/[{}:]/g, "")
			.split(/[-_]+/)
			.filter(Boolean)
			.map((x) => x[0].toUpperCase() + x.slice(1))
			.join("") || "Unknown"
	);
}
function params(path: string): string[] {
	return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}
function methodName(route: Route): string {
	return (
		route.method +
		route.path
			.split("/")
			.filter(Boolean)
			.map((part) => (part.startsWith("{") ? `By${pascal(part)}` : pascal(part)))
			.join("")
	);
}
function renderMethod(route: Route, name: string): string {
	const pathParams = params(route.path);
	const query = route.method === "get" || route.method === "delete";
	const args = pathParams.map((param) => `${param}: string`);
	args.push(`${query ? "query" : "opts"}?: Record<string, unknown>`);
	let path = route.path;
	for (const param of pathParams) path = path.replace(`{${param}}`, `\${${param}}`);
	const transport = route.method === "delete" ? "del" : route.method;
	return `  async ${name}(${args.join(", ")}): Promise<unknown> {\n    return this.transport.${transport}<unknown>(\`${path}\`, ${query ? "query" : "opts"});\n  }`;
}
export function generateClient(routes: readonly Route[]): string {
	const seen = new Map<string, number>();
	const methods = routes
		.map((route) => {
			const base = methodName(route);
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			return renderMethod(route, count ? `${base}${count + 1}` : base);
		})
		.join("\n\n");
	return `/** AUTO-GENERATED — DO NOT EDIT. Source: scripts/routes.json native HTTP contract. */\nexport class GeneratedClient {\n  constructor(private readonly transport: {\n    readonly get: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;\n    readonly post: <T>(path: string, body?: unknown) => Promise<T>;\n    readonly put: <T>(path: string, body?: unknown) => Promise<T>;\n    readonly patch: <T>(path: string, body?: unknown) => Promise<T>;\n    readonly del: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;\n  }) {}\n\n${methods}\n}\n`;
}
if (import.meta.main) writeFileSync(OUTPUT, generateClient(loadRoutes()));
