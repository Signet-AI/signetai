#!/usr/bin/env bun
/** Generate the SDK client from fresh Rust route declarations; never launches daemon code. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../platform/rust-daemon/src");
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), "../src/generated/client.ts");
type Method = "get" | "post" | "put" | "patch" | "delete";
export interface Route {
	readonly method: Method;
	readonly path: string;
}

function calls(source: string): string[] {
	const result: string[] = [];
	for (let start = source.indexOf(".route("); start >= 0; start = source.indexOf(".route(", start + 7)) {
		let depth = 0;
		for (let i = start + 6; i < source.length; i++) {
			if (source[i] === "(") depth++;
			if (source[i] === ")" && --depth === 0) {
				result.push(source.slice(start, i + 1));
				break;
			}
		}
	}
	return result;
}
export function extractRoutes(source: string): readonly Route[] {
	const routes: Route[] = [];
	for (const call of calls(source)) {
		const path = call.match(/\.route\(\s*["']([^"']+)["']/)?.[1];
		if (!path) continue;
		const handlers = call.slice(call.indexOf(path) + path.length);
		for (const method of ["get", "post", "put", "patch", "delete"] as const) {
			if (new RegExp(`\\b(?:route_)?${method}\\s*\\(`).test(handlers)) routes.push({ method, path });
		}
	}
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
	return [...path.matchAll(/(?:[:{])([A-Za-z_][A-Za-z0-9_]*)(?:})?/g)].map((m) => m[1]);
}
function name(route: Route): string {
	return (
		route.method +
		route.path
			.split("/")
			.filter(Boolean)
			.map((x) => (x.startsWith(":") || x.startsWith("{") ? `By${pascal(x)}` : pascal(x)))
			.join("")
	);
}
function method(route: Route, methodName: string): string {
	const pathParams = params(route.path);
	const args = pathParams.map((x) => `${x}: string`);
	const isQuery = route.method === "get" || route.method === "delete";
	args.push(`${isQuery ? "query" : "opts"}?: Record<string, unknown>`);
	let path = route.path;
	for (const param of pathParams) path = path.replace(`{${param}}`, `\${${param}}`);
	const transportMethod = route.method === "delete" ? "del" : route.method;
	return `  async ${methodName}(${args.join(", ")}): Promise<unknown> {\n    return this.transport.${transportMethod}<unknown>(\`${path}\`, ${isQuery ? "query" : "opts"});\n  }`;
}
export function generateClient(routes: readonly Route[]): string {
	const seen = new Map<string, number>();
	const methods = routes
		.map((route) => {
			const base = name(route);
			const n = seen.get(base) ?? 0;
			seen.set(base, n + 1);
			return method(route, n ? `${base}${n + 1}` : base);
		})
		.join("\n\n");
	return `/** AUTO-GENERATED — DO NOT EDIT. Source: platform/rust-daemon/src route declarations. */
export class GeneratedClient {
  constructor(private readonly transport: {
    readonly get: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
    readonly post: <T>(path: string, body?: unknown) => Promise<T>;
    readonly put: <T>(path: string, body?: unknown) => Promise<T>;
    readonly patch: <T>(path: string, body?: unknown) => Promise<T>;
    readonly del: <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
  }) {}

${methods}
}
`;
}
function main(): void {
	if (!existsSync(ROOT)) throw new Error(`Rust daemon source not found at ${ROOT}`);
	const modules = readFileSync(join(ROOT, "routes/mod.rs"), "utf8").matchAll(/mod (\w+);/g);
	const files = ["main.rs", ...[...modules].map((m) => `routes/${m[1]}.rs`)];
	const routes = extractRoutes(files.map((file) => readFileSync(join(ROOT, file), "utf8")).join("\n"));
	if (!routes.length) throw new Error("No Rust daemon routes found; refusing empty generation");
	mkdirSync(dirname(OUTPUT), { recursive: true });
	writeFileSync(OUTPUT, generateClient(routes));
	console.log(`Generated ${routes.length} SDK methods from Rust route declarations`);
}
if (import.meta.main) main();
