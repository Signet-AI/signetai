import assert from "node:assert/strict";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import effects from "../../../platform/daemon/src/route-effects.json";

export interface RouteRegistration {
	readonly file: string;
	readonly method: string;
	readonly path: string;
	readonly effect: string;
	readonly writesEvidence: boolean;
	readonly paths: readonly string[];
}

const sourceRoot = join(import.meta.dir, "../../../platform/daemon/src");
const methods = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);
const effectTags = new Set([
	"host",
	"host-input",
	"host-paths",
	"records",
	"supervised",
	"evidence",
	"host-input-evidence",
	"host-paths-evidence",
]);

function literalValues(expression: ts.Expression): readonly string[] | undefined {
	const value = ts.isAsExpression(expression) ? expression.expression : expression;
	if (!ts.isArrayLiteralExpression(value)) return undefined;
	const values = value.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
	return values.length === value.elements.length ? values : undefined;
}

function templatePaths(node: ts.CallExpression, path: string): readonly string[] {
	let paths = [path];
	for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
		if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) continue;
		const declaration = parent.initializer.declarations[0];
		if (!declaration || !ts.isIdentifier(declaration.name)) continue;
		const values = literalValues(parent.expression);
		if (!values) continue;
		const marker = `\${${declaration.name.text}}`;
		paths = paths.flatMap((item) =>
			item.includes(marker) ? values.map((value) => item.replaceAll(marker, value)) : [item],
		);
	}
	return paths;
}

export async function loadRouteInventory(): Promise<readonly RouteRegistration[]> {
	const discovered: Record<string, string[]> = {};
	const expanded = new Map<string, readonly string[]>();
	for await (const file of new Glob("**/*.ts").scan({ cwd: sourceRoot })) {
		if (file.includes(".test.") || file.split("/").includes("__tests__")) continue;
		const source = ts.createSourceFile(
			file,
			await readFile(join(sourceRoot, file), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const routes = new Set<string>();
		function visit(node: ts.Node): void {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
				const method = node.expression.name.text;
				const arg = node.arguments[0];
				if (methods.has(method) && arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))) {
					const path = arg.getText(source).slice(1, -1);
					if (path.startsWith("/")) {
						const signature = `${method.toUpperCase()} ${path}`;
						routes.add(signature);
						const key = `${file} ${signature}`;
						expanded.set(key, [...new Set([...(expanded.get(key) ?? []), ...templatePaths(node, path)])]);
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		if (routes.size) discovered[file] = [...routes].sort();
	}
	const declared = Object.fromEntries(
		Object.entries(effects).map(([file, routes]) => [file, Object.keys(routes).sort()]),
	);
	assert.deepEqual(discovered, declared, "Every registration must declare its reviewed host/evidence effect");
	return Object.entries(effects).flatMap(([file, routes]) =>
		Object.entries(routes).map(([signature, effect]) => {
			assert(effectTags.has(effect), `Unreviewed effect: ${file} ${signature} ${effect}`);
			const separator = signature.indexOf(" ");
			const method = signature.slice(0, separator);
			const path = signature.slice(separator + 1);
			const paths = expanded.get(`${file} ${signature}`);
			assert(paths?.length, `Missing registration: ${file} ${signature}`);
			return {
				file,
				method,
				path,
				effect,
				writesEvidence: effect === "evidence" || effect.endsWith("-evidence"),
				paths,
			};
		}),
	);
}

export function routeProbePaths(route: RouteRegistration): readonly string[] {
	return route.paths.map((path) => {
		assert(!path.includes("${"), `Supply concrete template cases for ${route.file} ${route.path}`);
		return path.replace(/:[A-Za-z_][A-Za-z_0-9]*(?:\{[^}]*\})?/g, "probe");
	});
}
