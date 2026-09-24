import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export type CaseStatus = "passed" | "failed" | "skipped";

export type JUnitCaseIdentity = {
	readonly key: string;
	readonly file: string;
	readonly line: string;
	readonly classname: string;
	readonly name: string;
	readonly suitePath: readonly string[];
	readonly status: CaseStatus;
	readonly parameters?: unknown;
	readonly parameterIndex?: number;
	readonly parameterDigest?: string;
};

export type SuiteHookIdentity = {
	readonly file: string;
	readonly classname: string;
	readonly suitePath: readonly string[];
	readonly hook: string;
	readonly sourceLine: number;
	readonly status: Exclude<CaseStatus, "passed">;
};

export type JUnitIdentityCollision = { readonly key: string; readonly count: number };

export type JUnitIdentityResolution = {
	readonly caseIdentities: readonly JUnitCaseIdentity[];
	readonly suiteHookIdentities: readonly SuiteHookIdentity[];
	readonly identityCollisions: readonly JUnitIdentityCollision[];
	readonly unresolvedIdentityCount: number;
};

type JUnitCase = {
	readonly xml: string;
	readonly file: string;
	readonly line: string;
	readonly classname: string;
	readonly name: string;
	readonly status: CaseStatus;
};

type StaticValue = { readonly known: true; readonly value: unknown } | { readonly known: false };

type SourceTest = {
	readonly line: number;
	readonly suitePath: readonly string[];
	readonly name: string | undefined;
	readonly parameterRows: readonly unknown[] | null | undefined;
};

type SourceHook = {
	readonly line: number;
	readonly suitePath: readonly string[];
	readonly hook: string;
};

type SourceIndex = { readonly tests: readonly SourceTest[]; readonly hooks: readonly SourceHook[] };

type SourceCaseMatch = {
	readonly source: SourceTest;
	readonly parameter?: { readonly row: unknown; readonly rowIndex: number };
};

function decodeAttribute(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function attribute(source: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const value = source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? "";
	return decodeAttribute(value);
}

function status(xml: string): CaseStatus {
	if (/<(?:failure|error)\b/.test(xml)) return "failed";
	if (/<skipped\b/.test(xml)) return "skipped";
	return "passed";
}

function parseCase(xml: string): JUnitCase {
	return {
		xml,
		file: attribute(xml, "file"),
		line: attribute(xml, "line"),
		classname: attribute(xml, "classname"),
		name: attribute(xml, "name"),
		status: status(xml),
	};
}

function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function callRoot(
	expression: ts.Expression,
): { readonly root: string; readonly methods: readonly string[] } | undefined {
	const value = unwrap(expression);
	if (ts.isIdentifier(value)) return { root: value.text, methods: [] };
	if (ts.isPropertyAccessExpression(value)) {
		const parent = callRoot(value.expression);
		return parent ? { root: parent.root, methods: [...parent.methods, value.name.text] } : undefined;
	}
	if (ts.isCallExpression(value)) return callRoot(value.expression);
	return undefined;
}

function stringLiteral(node: ts.Expression | undefined): string | undefined {
	if (!node) return undefined;
	const value = unwrap(node);
	if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
	return undefined;
}

function staticValue(node: ts.Expression): StaticValue {
	const value = unwrap(node);
	if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { known: true, value: value.text };
	if (ts.isNumericLiteral(value)) return { known: true, value: Number(value.text) };
	if (value.kind === ts.SyntaxKind.TrueKeyword) return { known: true, value: true };
	if (value.kind === ts.SyntaxKind.FalseKeyword) return { known: true, value: false };
	if (value.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
	if (ts.isIdentifier(value) && value.text === "undefined") return { known: true, value: undefined };
	if (
		ts.isPrefixUnaryExpression(value) &&
		(value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken) &&
		ts.isNumericLiteral(value.operand)
	) {
		const numberValue = Number(value.operand.text) * (value.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
		return { known: true, value: numberValue };
	}
	if (ts.isArrayLiteralExpression(value)) {
		const output: unknown[] = [];
		for (const element of value.elements) {
			if (ts.isSpreadElement(element)) return { known: false };
			const elementValue = staticValue(element);
			if (!elementValue.known) return { known: false };
			output.push(elementValue.value);
		}
		return { known: true, value: output };
	}
	if (ts.isObjectLiteralExpression(value)) {
		const output: Record<string, unknown> = {};
		for (const property of value.properties) {
			if (!ts.isPropertyAssignment(property)) return { known: false };
			let name: string | undefined;
			if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
				name = property.name.text;
			if (name === undefined) return { known: false };
			const propertyValue = staticValue(property.initializer);
			if (!propertyValue.known) return { known: false };
			output[name] = propertyValue.value;
		}
		return { known: true, value: output };
	}
	return { known: false };
}

function canonicalValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (typeof value === "number") return `number:${String(value)}`;
	if (typeof value === "boolean") return `boolean:${String(value)}`;
	if (Array.isArray(value)) return `array:[${value.map(canonicalValue).join(",")}]`;
	if (typeof value === "object") return `json:${JSON.stringify(value) ?? "undefined"}`;
	return `unsupported:${typeof value}`;
}

function formatEachName(pattern: string, row: unknown, index: number): string | undefined {
	const values = Array.isArray(row) ? row : [row];
	let valueIndex = 0;
	let supported = true;
	const name = pattern.replace(/%%|%[#sdifj]/g, (token) => {
		if (token === "%%") return "%";
		if (token === "%#") return String(index);
		const value = values[valueIndex];
		valueIndex += 1;
		if (token === "%j") {
			try {
				return JSON.stringify(value) ?? "undefined";
			} catch {
				supported = false;
				return token;
			}
		}
		if (token === "%d" || token === "%i" || token === "%f") {
			if (typeof value !== "number") {
				supported = false;
				return token;
			}
			return String(value);
		}
		if (value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			return String(value);
		supported = false;
		return token;
	});
	return supported ? name : undefined;
}

function parameterRows(call: ts.CallExpression): readonly unknown[] | null | undefined {
	const expression = unwrap(call.expression);
	if (!ts.isCallExpression(expression)) return undefined;
	const each = callRoot(expression.expression);
	if (!each || !["test", "it"].includes(each.root) || !each.methods.includes("each")) return undefined;
	const table = expression.arguments[0];
	if (!table) return null;
	const result = staticValue(table);
	return result.known && Array.isArray(result.value) ? result.value : null;
}

function matchesSuiteClassname(suitePath: readonly string[], classname: string): boolean {
	return [suitePath.join(" > "), [...suitePath].reverse().join(" > ")].some((candidate) => candidate === classname);
}

function sourceIndex(sourceRoot: string, file: string): SourceIndex | undefined {
	if (!file || file.startsWith("/") || file.includes("\\")) return undefined;
	const root = resolve(sourceRoot);
	const path = resolve(root, file);
	const pathFromRoot = relative(root, path);
	if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep))
		return undefined;
	if (!existsSync(path)) return undefined;

	const text = readFileSync(path, "utf8");
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const tests: SourceTest[] = [];
	const hooks: SourceHook[] = [];
	const hookNames = new Set(["beforeAll", "afterAll", "beforeEach", "afterEach"]);

	const visit = (node: ts.Node, suitePath: readonly string[]): void => {
		if (ts.isCallExpression(node)) {
			const info = callRoot(node.expression);
			if (info?.root === "describe") {
				const name = stringLiteral(node.arguments[0]);
				const callback = node.arguments[node.arguments.length - 1];
				if (name !== undefined && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
					visit(callback, [...suitePath, name]);
					return;
				}
			}
			if (info && ["test", "it"].includes(info.root)) {
				const nameArgument = node.arguments[0];
				const name = stringLiteral(nameArgument);
				if (nameArgument) {
					const line = source.getLineAndCharacterOfPosition(nameArgument.getStart(source)).line + 1;
					tests.push({
						line,
						suitePath,
						name,
						parameterRows: parameterRows(node),
					});
				}
				return;
			}
			if (info && hookNames.has(info.root)) {
				const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
				hooks.push({ line, suitePath, hook: info.root });
				return;
			}
		}
		ts.forEachChild(node, (child) => visit(child, suitePath));
	};
	visit(source, []);
	return { tests, hooks };
}

function caseBaseKey(testcase: JUnitCase): string {
	return `${testcase.file}\0${testcase.line}\0${testcase.classname}\0${testcase.name}`;
}

function isSuiteHookMarker(testcase: JUnitCase): boolean {
	return testcase.name === "(unnamed)" && testcase.line === "" && testcase.status !== "passed";
}

function resolveTestcaseSources(
	testcases: readonly JUnitCase[],
	sourceRoot: string | undefined,
): Map<number, SourceCaseMatch> {
	const resolved = new Map<number, SourceCaseMatch>();
	if (!sourceRoot) return resolved;
	const byFile = new Map<string, SourceIndex | undefined>();
	const sourceFor = (file: string): SourceIndex | undefined => {
		if (!byFile.has(file)) byFile.set(file, sourceIndex(sourceRoot, file));
		return byFile.get(file);
	};
	const groups = new Map<string, number[]>();
	for (const [index, testcase] of testcases.entries()) {
		if (isSuiteHookMarker(testcase)) continue;
		const group = groups.get(caseBaseKey(testcase)) ?? [];
		group.push(index);
		groups.set(caseBaseKey(testcase), group);
	}
	for (const indexes of groups.values()) {
		const testcase = testcases[indexes[0] ?? -1];
		if (!testcase?.line) continue;
		const source = sourceFor(testcase.file);
		if (!source) continue;
		const line = Number(testcase.line);
		const declarations = source.tests.filter(
			(declaration) => declaration.line === line && matchesSuiteClassname(declaration.suitePath, testcase.classname),
		);
		let matches: SourceCaseMatch[] = declarations.flatMap((declaration) => {
			if (declaration.parameterRows !== undefined || declaration.name !== testcase.name) return [];
			return [{ source: declaration }];
		});
		matches.push(
			...declarations.flatMap((declaration) => {
				const name = declaration.name;
				if (!declaration.parameterRows || name === undefined) return [];
				return declaration.parameterRows.flatMap((row, rowIndex) => {
					const renderedName = formatEachName(name, row, rowIndex);
					return renderedName === testcase.name ? [{ source: declaration, parameter: { row, rowIndex } }] : [];
				});
			}),
		);
		if (matches.length === 0 && indexes.length === 1) {
			const dynamicDeclarations = declarations.filter(
				(declaration) => declaration.parameterRows === null || declaration.name === undefined,
			);
			const dynamicDeclaration = dynamicDeclarations[0];
			if (dynamicDeclarations.length === 1 && dynamicDeclaration) matches = [{ source: dynamicDeclaration }];
		}
		if (matches.length !== indexes.length || new Set(matches.map((match) => match.source)).size !== 1) continue;
		if (matches.some((match) => match.parameter === undefined) && indexes.length !== 1) continue;
		for (const [offset, caseIndex] of indexes.entries()) {
			const match = matches[offset];
			if (match) resolved.set(caseIndex, match);
		}
	}
	return resolved;
}

function resolveHookMarkers(
	testcases: readonly JUnitCase[],
	sourceRoot: string | undefined,
): Map<number, { readonly source: SourceHook; readonly status: Exclude<CaseStatus, "passed"> }> {
	const resolved = new Map<number, { readonly source: SourceHook; readonly status: Exclude<CaseStatus, "passed"> }>();
	if (!sourceRoot) return resolved;
	const byFile = new Map<string, SourceIndex | undefined>();
	const sourceFor = (file: string): SourceIndex | undefined => {
		if (!byFile.has(file)) byFile.set(file, sourceIndex(sourceRoot, file));
		return byFile.get(file);
	};
	const groups = new Map<string, number[]>();
	for (const [index, testcase] of testcases.entries()) {
		if (!isSuiteHookMarker(testcase)) continue;
		const key = `${testcase.file}\0${testcase.classname}`;
		const group = groups.get(key) ?? [];
		group.push(index);
		groups.set(key, group);
	}
	for (const indexes of groups.values()) {
		const testcase = testcases[indexes[0] ?? -1];
		if (!testcase) continue;
		const source = sourceFor(testcase.file);
		if (!source) continue;
		// Bun serializes suite-level beforeAll/afterAll outcomes as unnamed JUnit cases;
		// per-test hooks are not independent records and must not consume those markers.
		const suiteHooks = new Set(["beforeAll", "afterAll"]);
		const hooks = source.hooks.filter(
			(hook) => matchesSuiteClassname(hook.suitePath, testcase.classname) && suiteHooks.has(hook.hook),
		);
		const unnamedTestExists = source.tests.some(
			(declaration) =>
				matchesSuiteClassname(declaration.suitePath, testcase.classname) && declaration.name === "(unnamed)",
		);
		if (unnamedTestExists || hooks.length !== indexes.length || hooks.length === 0) continue;
		for (const [offset, caseIndex] of indexes.entries()) {
			const hook = hooks[offset];
			const marker = testcases[caseIndex];
			if (hook && marker && marker.status !== "passed")
				resolved.set(caseIndex, { source: hook, status: marker.status });
		}
	}
	return resolved;
}

export function resolveJUnitCaseIdentities(caseXml: readonly string[], sourceRoot?: string): JUnitIdentityResolution {
	const testcases = caseXml.map(parseCase);
	const hooks = resolveHookMarkers(testcases, sourceRoot);
	const sourceCases = resolveTestcaseSources(testcases, sourceRoot);
	const identities: JUnitCaseIdentity[] = [];
	const hookIdentities: SuiteHookIdentity[] = [];
	let unresolvedIdentityCount = 0;
	for (const [index, testcase] of testcases.entries()) {
		const hook = hooks.get(index);
		if (hook) {
			hookIdentities.push({
				file: testcase.file,
				classname: testcase.classname,
				suitePath: hook.source.suitePath,
				hook: hook.source.hook,
				sourceLine: hook.source.line,
				status: hook.status,
			});
			continue;
		}
		const sourceCase = sourceCases.get(index);
		const suitePath = sourceCase?.source.suitePath ?? [];
		const parameter = sourceCase?.parameter;
		const parameterDigest = parameter
			? createHash("sha256").update(canonicalValue(parameter.row)).digest("hex")
			: undefined;
		const key = sourceCase
			? `${caseBaseKey(testcase)}\0${suitePath.join("\0")}${parameter ? `\0parameter:${parameter.rowIndex}:${parameterDigest}` : ""}`
			: caseBaseKey(testcase);
		identities.push({
			key,
			file: testcase.file,
			line: testcase.line,
			classname: testcase.classname,
			name: testcase.name,
			suitePath,
			status: testcase.status,
			...(parameter && parameterDigest !== undefined
				? {
						parameters: parameter.row,
						parameterIndex: parameter.rowIndex,
						parameterDigest,
					}
				: {}),
		});
		if (!testcase.file || !testcase.line || !sourceCase) unresolvedIdentityCount += 1;
	}
	const counts = new Map<string, number>();
	for (const identity of identities) counts.set(identity.key, (counts.get(identity.key) ?? 0) + 1);
	const identityCollisions = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([key, count]) => ({ key, count }));
	return {
		caseIdentities: identities,
		suiteHookIdentities: hookIdentities,
		identityCollisions,
		unresolvedIdentityCount,
	};
}
