#!/usr/bin/env bun
/**
 * Build the deterministic, read-only architecture baseline.
 *
 * The default mode only reads the repository and prints the current inventory.
 * `--write-baseline` is the deliberate baseline update operation; it writes
 * the machine-readable snapshot and its human-readable report together.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export type EdgeKind = "import" | "export" | "dynamic-import" | "require";
export type SourceLayer = "contracts" | "domain" | "adapters" | "routes" | "composition-root";

export interface SourceEdge {
	readonly id: string;
	readonly from: string;
	readonly to: string | null;
	readonly specifier: string;
	readonly kind: EdgeKind;
	readonly runtime: boolean;
	readonly line: number;
}

export interface ComputedLoad {
	readonly id: string;
	readonly path: string;
	readonly kind: "dynamic-import" | "require";
	readonly expression: string;
	readonly line: number;
}

export interface GeneratedArtifact {
	readonly path: string;
	readonly lines: number;
	readonly bytes: number;
	readonly materialized: boolean;
	readonly reason: "generated-marker" | "generated-path" | "manifested-output" | "bundle-name";
}

export interface GeneratedArtifactManifestEntry {
	readonly path: string;
	readonly owner: string;
	readonly source: string;
	readonly generatedBy: string;
}

export interface SourceModule {
	readonly id: string;
	readonly path: string;
	readonly lines: number;
	readonly logicalStatements: number;
	readonly exports: number;
	readonly topLevelMutableBindings: number;
	readonly typeEscapes: number;
	readonly runtimeFanIn: number;
	readonly runtimeFanOut: number;
	readonly runtimeCallsitesIn: number;
	readonly runtimeCallsitesOut: number;
	readonly dynamicSites: number;
	readonly layer: SourceLayer;
}

export interface Cycle {
	readonly id: string;
	readonly nodes: readonly string[];
}

export interface PackageRecord {
	readonly id: string;
	readonly path: string;
	readonly name: string;
	readonly dependencies: readonly string[];
	readonly devDependencies: readonly string[];
	readonly peerDependencies: readonly string[];
	readonly optionalDependencies: readonly string[];
}

export interface ArchitectureInventory {
	readonly generatedFrom: string;
	readonly sourceRoot: string;
	readonly sourceFiles: readonly SourceModule[];
	readonly sourceEdges: readonly SourceEdge[];
	readonly computedLoads: readonly ComputedLoad[];
	readonly generatedArtifacts: readonly GeneratedArtifact[];
	readonly generatedArtifactManifest: readonly GeneratedArtifactManifestEntry[];
	readonly runtimeCycles: readonly Cycle[];
	readonly typeCycles: readonly Cycle[];
	readonly packages: readonly PackageRecord[];
	readonly packageRuntimeEdges: readonly { readonly from: string; readonly to: string }[];
	readonly packageAllEdges: readonly { readonly from: string; readonly to: string }[];
	readonly summary: {
		readonly files: number;
		readonly lines: number;
		readonly logicalStatements: number;
		readonly runtimeEdges: number;
		readonly allEdges: number;
		readonly unresolvedEdges: number;
		readonly dynamicLiteralSites: number;
		readonly computedLoads: number;
		readonly runtimeCycles: number;
		readonly typeCycles: number;
		readonly packages: number;
		readonly packageRuntimeCycles: number;
		readonly packageAllCycles: number;
		readonly typeEscapes: number;
	};
}

interface PackageJson {
	readonly name?: unknown;
	readonly private?: unknown;
	readonly dependencies?: unknown;
	readonly devDependencies?: unknown;
	readonly peerDependencies?: unknown;
	readonly optionalDependencies?: unknown;
}

interface BaselineFile {
	readonly version: 1;
	readonly generatedFrom: string;
	readonly inventory: ArchitectureInventory;
}

interface GeneratedArtifactManifestFile {
	readonly version: 1;
	readonly artifacts: readonly GeneratedArtifactManifestEntry[];
}

export interface AuditOptions {
	readonly root?: string;
	readonly sourceRoot?: string;
}

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "scripts/architecture-baseline.json");
const REPORT_PATH = join(ROOT, "docs/architecture-audit.md");
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
const EXCLUDED_DIRECTORY_NAMES = new Set([
	".git",
	"node_modules",
	"dist",
	"built",
	"build",
	"fixtures",
	"coverage",
	"target",
	"references",
	".native-build",
	".worktrees",
	".wrangler",
	".svelte-kit",
	".astro",
]);
const EXCLUDED_PATH_PARTS = ["/__tests__/", "/tests/", "/.bench/"];
const GENERATED_FROM = "bun scripts/audit-architecture-contract.ts --write-baseline";

function normalizedPath(path: string): string {
	return path.split(sep).join("/");
}

function relativePath(root: string, path: string): string {
	return normalizedPath(relative(root, path));
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isSourceFile(path: string): boolean {
	const normalized = normalizedPath(path);
	return (
		SOURCE_EXTENSIONS.includes(extname(path) as (typeof SOURCE_EXTENSIONS)[number]) &&
		!path.endsWith(".d.ts") &&
		!normalized.endsWith(".test.ts") &&
		!normalized.endsWith(".test.tsx") &&
		!normalized.endsWith(".bench.ts") &&
		!normalized.endsWith(".bench.tsx") &&
		!normalized.includes("/generated/") &&
		!EXCLUDED_PATH_PARTS.some((part) => normalized.includes(part))
	);
}

function generatedArtifactReason(
	_manifested: GeneratedArtifactManifestEntry | undefined,
): GeneratedArtifact["reason"] | null {
	return _manifested === undefined ? null : "manifested-output";
}

function unmanifestedGeneratedReason(
	path: string,
	source: string,
): Exclude<GeneratedArtifact["reason"], "manifested-output"> | null {
	const normalized = normalizedPath(path);
	if (normalized.includes("/generated/")) return "generated-path";
	if ((normalized.endsWith("-bundle.ts") || normalized.endsWith(".bundle.ts")) && normalized.includes("/src/"))
		return "bundle-name";
	const header = source.split("\n").slice(0, 12).join("\n");
	return /AUTO-GENERATED FILE|Auto-generated by|AUTO-GENERATED from/.test(header) ? "generated-marker" : null;
}

function manifestPath(root: string, value: string, label: string): string {
	if (value.length === 0 || value.startsWith("/") || value.includes("\\")) {
		throw new Error(`Invalid generated artifact manifest ${label}: ${value}`);
	}
	const resolved = resolve(root, value);
	const relativeValue = relativePath(root, resolved);
	if (relativeValue !== value || relativeValue.startsWith("../") || relativeValue === "..") {
		throw new Error(`Generated artifact manifest ${label} must be a relative path within the repository: ${value}`);
	}
	return resolved;
}

function generatedHeader(source: string): string {
	return source.split("\n").slice(0, 12).join("\n");
}

function hasGeneratedMarker(source: string): boolean {
	return /AUTO-GENERATED FILE|Auto-generated by|AUTO-GENERATED from/.test(generatedHeader(source));
}

function generatedOutputPaths(root: string, generatorPath: string): ReadonlySet<string> {
	const source = readFileSync(generatorPath, "utf8");
	const sourceFile = ts.createSourceFile(generatorPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const bindings = new Map<string, ts.Expression>();
	const outputs = new Set<string>();
	const staticPath = (expression: ts.Expression, resolving = new Set<string>()): string | null => {
		const unwrapped = unwrapExpression(expression);
		if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
		if (ts.isIdentifier(unwrapped)) {
			if (unwrapped.text === "__dirname") return dirname(generatorPath);
			const initializer = bindings.get(unwrapped.text);
			if (initializer === undefined || resolving.has(unwrapped.text)) return null;
			const nextResolving = new Set(resolving);
			nextResolving.add(unwrapped.text);
			return staticPath(initializer, nextResolving);
		}
		if (ts.isNewExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === "URL") {
			return dirname(generatorPath);
		}
		if (!ts.isCallExpression(unwrapped)) return null;
		const callee = unwrapExpression(unwrapped.expression);
		const calleeName = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: null;
		const values: string[] = [];
		const argumentsValue = unwrapped.arguments.map((argument) => staticPath(argument, resolving));
		for (const value of argumentsValue) {
			if (value === null) return null;
			values.push(value);
		}
		if (calleeName === "join") return join(...values);
		if (calleeName === "resolve") return resolve(...values);
		if (calleeName === "dirname") return dirname(values[0] ?? generatorPath);
		if (calleeName === "fileURLToPath") {
			const argument = unwrapped.arguments[0];
			return argument !== undefined && ts.isNewExpression(argument) ? dirname(generatorPath) : generatorPath;
		}
		return null;
	};
	const visit = (node: ts.Node, scope: StaticScope): void => {
		let currentScope = scope;
		if (isFunctionLike(node)) {
			currentScope = { parent: scope, bindings: new Map(), isVarScope: true };
			for (const parameter of node.parameters) bindPattern(currentScope, parameter.name, null);
			predeclareVarBindings(node, currentScope);
			predeclareFunctionBindings(node, currentScope);
		} else if (
			ts.isSourceFile(node) ||
			ts.isBlock(node) ||
			ts.isCaseBlock(node) ||
			ts.isCatchClause(node) ||
			ts.isForStatement(node) ||
			ts.isForInStatement(node) ||
			ts.isForOfStatement(node)
		) {
			currentScope = {
				parent: scope,
				bindings: new Map(),
				isVarScope: ts.isSourceFile(node),
			};
			if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseBlock(node))
				predeclareScopeBindings(node, currentScope);
			if (ts.isSourceFile(node)) predeclareVarBindings(node, currentScope);
			if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))
				predeclareLoopBinding(node, currentScope);
		}
		if (ts.isCatchClause(node) && node.variableDeclaration !== undefined)
			bindPattern(currentScope, node.variableDeclaration.name, null);
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined)
			bindings.set(node.name.text, node.initializer);
		if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
			const flags = node.parent.flags;
			const isConst = (flags & ts.NodeFlags.Const) !== 0;
			const bindingScope = isConst
				? currentScope
				: (flags & ts.NodeFlags.Let) === 0
					? nearestVarScope(currentScope)
					: currentScope;
			bindPattern(bindingScope, node.name, isConst && ts.isIdentifier(node.name) ? (node.initializer ?? null) : null);
		}
		if (ts.isCallExpression(node)) {
			const callee = unwrapExpression(node.expression);
			const isWriteFileSync =
				(ts.isIdentifier(callee) && isCanonicalWriteFileSync(currentScope, callee.text)) ||
				(ts.isPropertyAccessExpression(callee) &&
					ts.isIdentifier(callee.expression) &&
					callee.name.text === "writeFileSync" &&
					isCanonicalFsNamespace(currentScope, callee.expression.text));
			if (isWriteFileSync) {
				const outputArgument = node.arguments[0];
				if (outputArgument !== undefined) {
					const output = staticPath(outputArgument);
					if (output !== null) outputs.add(resolve(root, output));
				}
			}
		}
		ts.forEachChild(node, (child) => visit(child, currentScope));
	};
	visit(sourceFile, { parent: undefined, bindings: new Map(), isVarScope: true });
	if (outputs.size === 0)
		throw new Error(
			`Generated artifact generator has no statically verifiable output path: ${relativePath(root, generatorPath)}`,
		);
	return outputs;
}

function loadGeneratedArtifactManifest(root: string): readonly GeneratedArtifactManifestEntry[] {
	const path = join(root, "scripts/architecture-generated-artifacts.json");
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8")) as GeneratedArtifactManifestFile;
	if (parsed.version !== 1 || !Array.isArray(parsed.artifacts))
		throw new Error(`Invalid generated artifact manifest: ${path}`);
	const packageNames = new Set(
		walk(root, (candidate) => candidate.endsWith("package.json")).flatMap((packagePath) => {
			try {
				const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
				return typeof packageJson.name === "string" ? [packageJson.name] : [];
			} catch {
				return [];
			}
		}),
	);
	const validated = parsed.artifacts.map((artifact) => {
		if (
			typeof artifact.path !== "string" ||
			typeof artifact.owner !== "string" ||
			typeof artifact.source !== "string" ||
			typeof artifact.generatedBy !== "string"
		)
			throw new Error(`Invalid generated artifact manifest entry in ${path}`);
		const artifactPath = manifestPath(root, artifact.path, "path");
		if (!packageNames.has(artifact.owner)) throw new Error(`Unknown generated artifact owner: ${artifact.owner}`);
		const sourcePath = manifestPath(root, artifact.source, "source");
		if (!existsSync(sourcePath)) throw new Error(`Generated artifact source does not exist: ${artifact.source}`);
		const generatorPath = manifestPath(root, artifact.generatedBy, "generatedBy");
		if (!existsSync(generatorPath) || !statSync(generatorPath).isFile())
			throw new Error(`Generated artifact generator is not a file: ${artifact.generatedBy}`);
		const generatorSource = readFileSync(generatorPath, "utf8");
		const outputPaths = generatedOutputPaths(root, generatorPath);
		if (!outputPaths.has(artifactPath)) {
			throw new Error(
				`Generated artifact generator ${artifact.generatedBy} does not write its exact output ${artifact.path}`,
			);
		}
		if (!generatorSource.includes(basename(artifact.source))) {
			throw new Error(
				`Generated artifact generator ${artifact.generatedBy} does not identify its source ${artifact.source}`,
			);
		}
		if (existsSync(artifactPath)) {
			if (!statSync(artifactPath).isFile()) throw new Error(`Generated artifact path is not a file: ${artifact.path}`);
			const artifactSource = readFileSync(artifactPath, "utf8");
			if (
				!hasGeneratedMarker(artifactSource) ||
				!generatedHeader(artifactSource).includes(basename(artifact.generatedBy))
			)
				throw new Error(
					`Generated artifact ${artifact.path} is materialized without a provenance header naming ${artifact.generatedBy}`,
				);
		}
		return artifact;
	});
	return [...validated].sort((a, b) => a.path.localeCompare(b.path));
}

function walk(root: string, predicate: (path: string) => boolean): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && predicate(path)) files.push(path);
		}
	};
	visit(root);
	return files.sort((a, b) => a.localeCompare(b));
}

function lineNumber(sourceFile: ts.SourceFile, position: number): number {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function normalizeSyntax(text: string): string {
	return text
		.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, "")
		.trim();
}

function sourceIdentity(path: string): string {
	return `module:${path}`;
}

function nodeIdentity(path: string, kind: string, node: ts.Node, sourceFile: ts.SourceFile): string {
	return `${path}:${kind}:${hash(normalizeSyntax(node.getText(sourceFile)))}`;
}

function sourceLayer(path: string): SourceLayer {
	const normalized = path.toLowerCase();
	if (normalized.includes("/routes/") || normalized.endsWith("-routes.ts")) return "routes";
	if (
		normalized.includes("/types/") ||
		normalized.includes("/contracts/") ||
		normalized.includes("schema") ||
		normalized.endsWith("-types.ts")
	)
		return "contracts";
	if (normalized.endsWith("/daemon.ts") || normalized.endsWith("/main.ts") || normalized.includes("/composition/"))
		return "composition-root";
	if (
		normalized.startsWith("integrations/") ||
		normalized.startsWith("surfaces/") ||
		normalized.includes("/adapters/") ||
		normalized.includes("/providers/")
	)
		return "adapters";
	return "domain";
}

function isTypeOnlyImport(declaration: ts.ImportDeclaration): boolean {
	const clause = declaration.importClause;
	if (clause === undefined) return false;
	if (clause.isTypeOnly) return true;
	if (clause.name !== undefined) return false;
	if (clause.namedBindings === undefined) return true;
	if (ts.isNamespaceImport(clause.namedBindings)) return false;
	return clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(declaration: ts.ExportDeclaration): boolean {
	if (declaration.isTypeOnly) return true;
	const clause = declaration.exportClause;
	return (
		clause !== undefined &&
		ts.isNamedExports(clause) &&
		clause.elements.every((element: ts.ExportSpecifier) => element.isTypeOnly)
	);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

interface StaticBinding {
	readonly initializer: ts.Expression | null;
	readonly canonicalCreateRequire: boolean;
	readonly canonicalWriteFileSync?: boolean;
	readonly canonicalFsNamespace?: boolean;
}

interface StaticScope {
	readonly parent: StaticScope | undefined;
	readonly bindings: Map<string, StaticBinding>;
	readonly isVarScope: boolean;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
	return (
		ts.isArrowFunction(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function bindPattern(
	scope: StaticScope,
	name: ts.BindingName,
	initializer: ts.Expression | null,
	canonicalCreateRequire = false,
	canonicalWriteFileSync = false,
	canonicalFsNamespace = false,
): void {
	if (ts.isIdentifier(name)) {
		scope.bindings.set(name.text, {
			initializer,
			canonicalCreateRequire,
			canonicalWriteFileSync,
			canonicalFsNamespace,
		});
		return;
	}
	for (const element of name.elements) {
		if (ts.isOmittedExpression(element)) continue;
		if (ts.isBindingElement(element)) bindPattern(scope, element.name, null);
	}
}

function bindDeclaration(scope: StaticScope, declaration: ts.Declaration): void {
	if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)) {
		const flags = declaration.parent.flags;
		const isConst = (flags & ts.NodeFlags.Const) !== 0;
		const isVar = (flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
		bindPattern(
			isVar ? nearestVarScope(scope) : scope,
			declaration.name,
			isConst && ts.isIdentifier(declaration.name) ? (declaration.initializer ?? null) : null,
		);
		return;
	}
	if (
		(ts.isFunctionDeclaration(declaration) ||
			ts.isClassDeclaration(declaration) ||
			ts.isEnumDeclaration(declaration)) &&
		declaration.name !== undefined
	) {
		bindPattern(scope, declaration.name, null);
	}
}

function nearestVarScope(scope: StaticScope): StaticScope {
	let current = scope;
	while (!current.isVarScope && current.parent !== undefined) current = current.parent;
	return current;
}

function predeclareVarBindings(node: ts.Node, scope: StaticScope): void {
	const visit = (candidate: ts.Node): void => {
		if (candidate !== node && isFunctionLike(candidate)) return;
		if (ts.isVariableDeclaration(candidate) && ts.isVariableDeclarationList(candidate.parent)) {
			const flags = candidate.parent.flags;
			if ((flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) bindDeclaration(scope, candidate);
		}
		ts.forEachChild(candidate, visit);
	};
	visit(node);
}

function predeclareScopeBindings(node: ts.Node, scope: StaticScope): void {
	const visit = (candidate: ts.Node): void => {
		if (
			candidate !== node &&
			(isFunctionLike(candidate) ||
				ts.isBlock(candidate) ||
				ts.isCaseBlock(candidate) ||
				ts.isForStatement(candidate) ||
				ts.isForInStatement(candidate) ||
				ts.isForOfStatement(candidate))
		) {
			if (ts.isFunctionDeclaration(candidate) || ts.isClassDeclaration(candidate) || ts.isEnumDeclaration(candidate))
				bindDeclaration(scope, candidate);
			return;
		}
		if (ts.isImportDeclaration(candidate) && candidate.importClause !== undefined) {
			const clause = candidate.importClause;
			const moduleSpecifier = ts.isStringLiteral(candidate.moduleSpecifier) ? candidate.moduleSpecifier.text : null;
			const isNodeFs = moduleSpecifier === "node:fs" || moduleSpecifier === "fs";
			if (clause.name !== undefined)
				scope.bindings.set(clause.name.text, {
					initializer: null,
					canonicalCreateRequire: false,
					canonicalFsNamespace: false,
				});
			if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
				scope.bindings.set(clause.namedBindings.name.text, {
					initializer: null,
					canonicalCreateRequire: false,
					canonicalFsNamespace: isNodeFs,
				});
			} else if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					const importedName = (element.propertyName ?? element.name).text;
					const isCanonicalCreateRequire =
						(moduleSpecifier === "node:module" || moduleSpecifier === "module") && importedName === "createRequire";
					scope.bindings.set(element.name.text, {
						initializer: null,
						canonicalCreateRequire: isCanonicalCreateRequire,
						canonicalWriteFileSync: isNodeFs && importedName === "writeFileSync",
					});
				}
			}
		}
		if (ts.isImportEqualsDeclaration(candidate)) {
			scope.bindings.set(candidate.name.text, { initializer: null, canonicalCreateRequire: false });
		}
		if (ts.isVariableDeclaration(candidate) && ts.isVariableDeclarationList(candidate.parent))
			bindDeclaration(scope, candidate);
		if (ts.isFunctionDeclaration(candidate) || ts.isClassDeclaration(candidate) || ts.isEnumDeclaration(candidate))
			bindDeclaration(scope, candidate);
		ts.forEachChild(candidate, visit);
	};
	visit(node);
}

function predeclareLoopBinding(
	node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement,
	scope: StaticScope,
): void {
	const initializer = node.initializer;
	if (initializer === undefined || !ts.isVariableDeclarationList(initializer)) return;
	for (const declaration of initializer.declarations) bindDeclaration(scope, declaration);
}

function predeclareFunctionBindings(node: ts.FunctionLikeDeclaration, scope: StaticScope): void {
	if (node.body === undefined || !ts.isBlock(node.body)) return;
	for (const statement of node.body.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) bindDeclaration(scope, declaration);
		}
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
			bindDeclaration(scope, statement);
	}
}

function resolveBinding(scope: StaticScope, name: string): { scope: StaticScope; binding: StaticBinding } | undefined {
	let current: StaticScope | undefined = scope;
	while (current !== undefined) {
		const binding = current.bindings.get(name);
		if (binding !== undefined) return { scope: current, binding };
		current = current.parent;
	}
	return undefined;
}

function isCanonicalCreateRequire(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalCreateRequire === true;
}

function isCanonicalWriteFileSync(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalWriteFileSync === true;
}

function isCanonicalFsNamespace(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalFsNamespace === true;
}

function isRuntimeRequire(expression: ts.Expression, scope: StaticScope): boolean {
	if (!ts.isIdentifier(expression) || expression.text !== "require") return false;
	const requireBinding = resolveBinding(scope, "require");
	if (requireBinding === undefined) return true;
	const initializer = requireBinding.binding.initializer;
	if (initializer === null || !ts.isCallExpression(initializer)) return false;
	const callee = unwrapExpression(initializer.expression);
	return ts.isIdentifier(callee) && isCanonicalCreateRequire(requireBinding.scope, callee.text);
}

function staticString(
	expression: ts.Expression,
	scope: StaticScope,
	resolving = new Set<ts.Expression>(),
): string | null {
	const unwrapped = unwrapExpression(expression);
	if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
	if (ts.isTemplateExpression(unwrapped)) {
		let value = unwrapped.head.text;
		for (const span of unwrapped.templateSpans) {
			const part = staticString(span.expression, scope, resolving);
			if (part === null) return null;
			value += part + span.literal.text;
		}
		return value;
	}
	if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = staticString(unwrapped.left, scope, resolving);
		const right = staticString(unwrapped.right, scope, resolving);
		return left !== null && right !== null ? left + right : null;
	}
	if (!ts.isIdentifier(unwrapped)) return null;
	let current: StaticScope | undefined = scope;
	while (current !== undefined) {
		if (current.bindings.has(unwrapped.text)) {
			const binding = current.bindings.get(unwrapped.text);
			const initializer = binding?.initializer ?? null;
			if (initializer === null || resolving.has(initializer)) return null;
			const nextResolving = new Set(resolving);
			nextResolving.add(initializer);
			return staticString(initializer, current, nextResolving);
		}
		current = current.parent;
	}
	return null;
}

interface PathAlias {
	readonly configDirectory: string;
	readonly prefix: string;
	readonly suffix: string;
	readonly hasWildcard: boolean;
	readonly baseUrl: string;
	readonly targets: readonly string[];
}

function loadPathAliases(root: string): readonly PathAlias[] {
	const aliases: PathAlias[] = [];
	for (const configPath of walk(root, (path) => basename(path) === "tsconfig.json")) {
		const result = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));
		if (result.error !== undefined || result.config === undefined) continue;
		const compilerOptions = result.config.compilerOptions;
		if (compilerOptions === undefined || typeof compilerOptions !== "object" || compilerOptions === null) continue;
		const paths = compilerOptions.paths;
		if (paths === undefined || typeof paths !== "object" || paths === null) continue;
		const baseUrl =
			typeof compilerOptions.baseUrl === "string"
				? resolve(dirname(configPath), compilerOptions.baseUrl)
				: dirname(configPath);
		for (const [pattern, value] of Object.entries(paths)) {
			if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) continue;
			const wildcard = pattern.indexOf("*");
			aliases.push({
				configDirectory: dirname(configPath),
				prefix: wildcard < 0 ? pattern : pattern.slice(0, wildcard),
				suffix: wildcard < 0 ? "" : pattern.slice(wildcard + 1),
				hasWildcard: wildcard >= 0,
				baseUrl,
				targets: value,
			});
		}
	}
	return aliases;
}

function aliasesForFile(path: string, aliases: readonly PathAlias[]): readonly PathAlias[] {
	const matching = aliases.filter(
		(alias) => path === alias.configDirectory || path.startsWith(`${alias.configDirectory}${sep}`),
	);
	const configDirectory = matching.sort((a, b) => b.configDirectory.length - a.configDirectory.length)[0]
		?.configDirectory;
	return configDirectory === undefined ? [] : matching.filter((alias) => alias.configDirectory === configDirectory);
}

function aliasTargets(specifier: string, aliases: readonly PathAlias[]): readonly string[] | null {
	const matching = aliases
		.filter((alias) =>
			alias.hasWildcard
				? specifier.length >= alias.prefix.length + alias.suffix.length &&
					specifier.startsWith(alias.prefix) &&
					specifier.endsWith(alias.suffix)
				: specifier === alias.prefix,
		)
		.sort((a, b) => b.prefix.length + b.suffix.length - (a.prefix.length + a.suffix.length));
	const alias = matching[0];
	if (alias === undefined) return null;
	const wildcard = alias.hasWildcard
		? specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length)
		: "";
	return alias.targets.map((target) => {
		const wildcardIndex = target.indexOf("*");
		if (wildcardIndex === -1) return resolve(alias.baseUrl, target);
		return resolve(alias.baseUrl, target.slice(0, wildcardIndex) + wildcard + target.slice(wildcardIndex + 1));
	});
}

function resolveFilePath(base: string, files: ReadonlySet<string>): string | null {
	const extension = extname(base);
	const sourceBase = RESOLUTION_EXTENSIONS.includes(extension as (typeof RESOLUTION_EXTENSIONS)[number])
		? base.slice(0, -extension.length)
		: base;
	const candidates = [
		base,
		sourceBase,
		...RESOLUTION_EXTENSIONS.map((item) => `${sourceBase}${item}`),
		...RESOLUTION_EXTENSIONS.map((item) => join(sourceBase, `index${item}`)),
	];
	for (const candidate of candidates) if (files.has(candidate)) return candidate;
	return null;
}

function resolveSourcePath(
	from: string,
	specifier: string,
	files: ReadonlySet<string>,
	aliases: readonly PathAlias[] = [],
): string | null {
	const configuredTargets = aliasTargets(specifier, aliases);
	if (configuredTargets !== null) {
		for (const target of configuredTargets) {
			const resolvedTarget = resolveFilePath(target, files);
			if (resolvedTarget !== null) return resolvedTarget;
		}
		return null;
	}
	if (!specifier.startsWith(".")) return null;
	return resolveFilePath(resolve(dirname(from), specifier), files);
}

function countStatements(sourceFile: ts.SourceFile): number {
	let count = 0;
	const visit = (node: ts.Node): void => {
		if (ts.isStatement(node) && !ts.isBlock(node) && !ts.isModuleBlock(node)) count++;
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return count;
}

function countExports(sourceFile: ts.SourceFile): number {
	let count = 0;
	for (const statement of sourceFile.statements) {
		if (
			ts.canHaveModifiers(statement) &&
			ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			if (ts.isVariableStatement(statement)) count += statement.declarationList.declarations.length;
			else if (
				ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isEnumDeclaration(statement)
			)
				count++;
			else count++;
		}
		if (ts.isExportDeclaration(statement)) {
			const clause = statement.exportClause;
			count += clause !== undefined && ts.isNamedExports(clause) ? clause.elements.length : 1;
		}
	}
	return count;
}

function countTypeEscapes(sourceFile: ts.SourceFile, source: string): number {
	let count = (source.match(/@ts-(?:ignore|expect-error)\b/g) ?? []).length;
	const visit = (node: ts.Node): void => {
		if (ts.isNonNullExpression(node)) count++;
		if (ts.isAsExpression(node)) {
			if (node.type.kind === ts.SyntaxKind.AnyKeyword) count++;
			if (ts.isAsExpression(node.expression)) count++;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return count;
}

function countTopLevelMutableBindings(sourceFile: ts.SourceFile): number {
	let count = 0;
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		const isMutable = (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
		if (isMutable) count += statement.declarationList.declarations.length;
	}
	return count;
}

function stronglyConnectedComponents(
	nodes: readonly string[],
	edges: readonly { readonly from: string; readonly to: string }[],
): Cycle[] {
	const adjacency = new Map<string, string[]>();
	for (const node of nodes) adjacency.set(node, []);
	for (const edge of edges) {
		const targets = adjacency.get(edge.from);
		if (targets !== undefined && !targets.includes(edge.to)) targets.push(edge.to);
	}
	let index = 0;
	const indexes = new Map<string, number>();
	const lowLinks = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: Cycle[] = [];
	const visit = (node: string): void => {
		indexes.set(node, index);
		lowLinks.set(node, index);
		index++;
		stack.push(node);
		onStack.add(node);
		for (const target of adjacency.get(node) ?? []) {
			if (!indexes.has(target)) {
				visit(target);
				lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(target) ?? 0));
			} else if (onStack.has(target)) {
				lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indexes.get(target) ?? 0));
			}
		}
		if (lowLinks.get(node) !== indexes.get(node)) return;
		const members: string[] = [];
		let current: string | undefined;
		do {
			current = stack.pop();
			if (current === undefined) break;
			onStack.delete(current);
			members.push(current);
		} while (current !== node);
		members.sort((a, b) => a.localeCompare(b));
		const selfCycle = members.length === 1 && (adjacency.get(members[0] ?? "") ?? []).includes(members[0] ?? "");
		if (members.length > 1 || selfCycle) components.push({ id: hash(members.join("\n")), nodes: members });
	};
	for (const node of [...nodes].sort((a, b) => a.localeCompare(b))) if (!indexes.has(node)) visit(node);
	return components.sort((a, b) => a.id.localeCompare(b.id));
}

function readPackageValue(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	return Object.keys(value).sort((a, b) => a.localeCompare(b));
}

function packageRecords(root: string): {
	readonly packages: PackageRecord[];
	readonly runtimeEdges: { readonly from: string; readonly to: string }[];
	readonly allEdges: { readonly from: string; readonly to: string }[];
} {
	const manifestPaths = walk(
		root,
		(path) => path.endsWith("package.json") && !relativePath(root, path).startsWith("dist/"),
	);
	const records: PackageRecord[] = [];
	const byName = new Map<string, PackageRecord>();
	for (const path of manifestPaths) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
		if (typeof parsed.name !== "string") continue;
		const record: PackageRecord = {
			id: relativePath(root, dirname(path)),
			path: relativePath(root, path),
			name: parsed.name,
			dependencies: readPackageValue(parsed.dependencies),
			devDependencies: readPackageValue(parsed.devDependencies),
			peerDependencies: readPackageValue(parsed.peerDependencies),
			optionalDependencies: readPackageValue(parsed.optionalDependencies),
		};
		records.push(record);
		byName.set(record.name, record);
	}
	records.sort((a, b) => a.id.localeCompare(b.id));
	const runtimeEdges: { from: string; to: string }[] = [];
	const allEdges: { from: string; to: string }[] = [];
	for (const record of records) {
		for (const dependency of [...record.dependencies, ...record.optionalDependencies, ...record.peerDependencies]) {
			if (byName.has(dependency)) runtimeEdges.push({ from: record.id, to: byName.get(dependency)?.id ?? "" });
		}
		for (const dependency of [
			...record.dependencies,
			...record.devDependencies,
			...record.optionalDependencies,
			...record.peerDependencies,
		]) {
			if (byName.has(dependency)) allEdges.push({ from: record.id, to: byName.get(dependency)?.id ?? "" });
		}
	}
	const dedupe = (edges: readonly { from: string; to: string }[]): { from: string; to: string }[] =>
		[...new Map(edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge])).values()].sort((a, b) =>
			`${a.from}\u0000${a.to}`.localeCompare(`${b.from}\u0000${b.to}`),
		);
	return { packages: records, runtimeEdges: dedupe(runtimeEdges), allEdges: dedupe(allEdges) };
}

export function analyzeSourceTree(options: AuditOptions = {}): ArchitectureInventory {
	const root = resolve(options.root ?? ROOT);
	const sourceRoot = resolve(options.sourceRoot ?? root);
	const generatedArtifactManifest = loadGeneratedArtifactManifest(root);
	const pathAliases = loadPathAliases(root);
	const manifestedByPath = new Map(generatedArtifactManifest.map((artifact) => [artifact.path, artifact]));
	const candidates = walk(
		sourceRoot,
		(path) =>
			SOURCE_EXTENSIONS.includes(extname(path) as (typeof SOURCE_EXTENSIONS)[number]) && !path.endsWith(".d.ts"),
	);
	const materializedManifestPaths = new Set<string>();
	const generatedArtifacts = candidates
		.filter((path) => !EXCLUDED_PATH_PARTS.some((part) => normalizedPath(path).includes(part)))
		.flatMap((path) => {
			const source = readFileSync(path, "utf8");
			const relative = relativePath(root, path);
			const manifested = manifestedByPath.get(relative);
			if (manifested !== undefined) materializedManifestPaths.add(relative);
			const unmanifestedReason = unmanifestedGeneratedReason(path, source);
			if (manifested === undefined && unmanifestedReason !== null) {
				throw new Error(
					`Generated artifact ${relative} matches ${unmanifestedReason} but is not listed in scripts/architecture-generated-artifacts.json`,
				);
			}
			const reason = generatedArtifactReason(manifested);
			return reason === null
				? []
				: [
						{
							path: relative,
							lines: source.split("\n").length,
							bytes: Buffer.byteLength(source),
							materialized: true,
							reason,
						},
					];
		})
		.concat(
			generatedArtifactManifest
				.filter((artifact) => !materializedManifestPaths.has(artifact.path))
				.map((artifact) => ({
					path: artifact.path,
					lines: 0,
					bytes: 0,
					materialized: false,
					reason: "manifested-output" as const,
				})),
		)
		.sort((a, b) => a.path.localeCompare(b.path));
	const paths = candidates.filter(
		(path) => isSourceFile(path) && generatedArtifactReason(manifestedByPath.get(relativePath(root, path))) === null,
	);
	const pathSet = new Set(paths);
	const modules = new Map<string, SourceModule>();
	const edges: SourceEdge[] = [];
	const computedLoads: ComputedLoad[] = [];
	const fanIn = new Map<string, Set<string>>();
	const callsitesIn = new Map<string, number>();
	const callsitesBySource = new Map<string, number>();
	for (const path of paths) {
		const source = readFileSync(path, "utf8");
		const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		const id = relativePath(sourceRoot, path);
		const edgeOccurrences = new Map<string, number>();
		const computedOccurrences = new Map<string, number>();
		modules.set(id, {
			id: sourceIdentity(id),
			path: id,
			lines: source.split("\n").length,
			logicalStatements: countStatements(sourceFile),
			exports: countExports(sourceFile),
			topLevelMutableBindings: countTopLevelMutableBindings(sourceFile),
			typeEscapes: countTypeEscapes(sourceFile, source),
			runtimeFanIn: 0,
			runtimeFanOut: 0,
			runtimeCallsitesIn: 0,
			runtimeCallsitesOut: 0,
			dynamicSites: 0,
			layer: sourceLayer(id),
		});
		const aliases = aliasesForFile(path, pathAliases);
		const addEdge = (kind: EdgeKind, specifier: string, node: ts.Node, runtime: boolean): void => {
			const target = resolveSourcePath(path, specifier, pathSet, aliases);
			const line = lineNumber(sourceFile, node.getStart(sourceFile));
			const identityBase = nodeIdentity(id, `${kind}:${runtime ? "runtime" : "type"}:${specifier}`, node, sourceFile);
			const occurrence = (edgeOccurrences.get(identityBase) ?? 0) + 1;
			edgeOccurrences.set(identityBase, occurrence);
			const edge: SourceEdge = {
				id: `${identityBase}:${occurrence}`,
				from: id,
				to: target === null ? null : relativePath(sourceRoot, target),
				specifier,
				kind,
				runtime,
				line,
			};
			edges.push(edge);
			if (runtime && target !== null) {
				const targetId = relativePath(sourceRoot, target);
				const incoming = fanIn.get(targetId) ?? new Set<string>();
				incoming.add(id);
				fanIn.set(targetId, incoming);
				callsitesIn.set(targetId, (callsitesIn.get(targetId) ?? 0) + 1);
				callsitesBySource.set(id, (callsitesBySource.get(id) ?? 0) + 1);
			}
		};
		const visit = (node: ts.Node, scope: StaticScope): void => {
			let currentScope = scope;
			if (isFunctionLike(node)) {
				currentScope = { parent: scope, bindings: new Map(), isVarScope: true };
				for (const parameter of node.parameters) bindPattern(currentScope, parameter.name, null);
				predeclareVarBindings(node, currentScope);
				predeclareFunctionBindings(node, currentScope);
			} else if (
				ts.isSourceFile(node) ||
				ts.isBlock(node) ||
				ts.isCaseBlock(node) ||
				ts.isCatchClause(node) ||
				ts.isForStatement(node) ||
				ts.isForInStatement(node) ||
				ts.isForOfStatement(node)
			) {
				currentScope = {
					parent: scope,
					bindings: new Map(),
					isVarScope: ts.isSourceFile(node),
				};
				if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseBlock(node))
					predeclareScopeBindings(node, currentScope);
				if (ts.isSourceFile(node)) predeclareVarBindings(node, currentScope);
				if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))
					predeclareLoopBinding(node, currentScope);
			}
			if (ts.isCatchClause(node) && node.variableDeclaration !== undefined)
				bindPattern(currentScope, node.variableDeclaration.name, null);
			if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
				const flags = node.parent.flags;
				const isConst = (flags & ts.NodeFlags.Const) !== 0;
				const bindingScope = isConst
					? currentScope
					: (flags & ts.NodeFlags.Let) === 0
						? nearestVarScope(currentScope)
						: currentScope;
				bindPattern(bindingScope, node.name, isConst && ts.isIdentifier(node.name) ? (node.initializer ?? null) : null);
			}
			if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
				addEdge("import", node.moduleSpecifier.text, node, !isTypeOnlyImport(node));
			}
			if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier !== undefined &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				addEdge("export", node.moduleSpecifier.text, node, !isTypeOnlyExport(node));
			}
			if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
				const expression = node.moduleReference.expression;
				if (expression !== undefined && ts.isStringLiteral(expression)) addEdge("import", expression.text, node, true);
			}
			if (ts.isCallExpression(node)) {
				const expression = node.expression;
				const argument = node.arguments[0];
				const kind =
					expression.kind === ts.SyntaxKind.ImportKeyword
						? "dynamic-import"
						: ts.isIdentifier(expression) && expression.text === "require"
							? "require"
							: null;
				const runtimeRequire = kind !== "require" || isRuntimeRequire(expression, currentScope);
				if (kind !== null && argument !== undefined) {
					const value = staticString(argument, currentScope);
					if (value === null || !runtimeRequire) {
						const identityBase = nodeIdentity(id, `computed:${kind}`, node, sourceFile);
						const occurrence = (computedOccurrences.get(identityBase) ?? 0) + 1;
						computedOccurrences.set(identityBase, occurrence);
						computedLoads.push({
							id: `${identityBase}:${occurrence}`,
							path: id,
							kind,
							expression: normalizeSyntax(argument.getText(sourceFile)),
							line: lineNumber(sourceFile, node.getStart(sourceFile)),
						});
					} else {
						addEdge(kind, value, node, true);
					}
				}
			}
			ts.forEachChild(node, (child) => visit(child, currentScope));
		};
		visit(sourceFile, { parent: undefined, bindings: new Map(), isVarScope: true });
	}
	const sourceModules = [...modules.values()]
		.map((module) => ({
			...module,
			runtimeFanIn: fanIn.get(module.path)?.size ?? 0,
			runtimeFanOut: new Set(
				edges.filter((edge) => edge.runtime && edge.from === module.path && edge.to !== null).map((edge) => edge.to),
			).size,
			runtimeCallsitesIn: callsitesIn.get(module.path) ?? 0,
			runtimeCallsitesOut: callsitesBySource.get(module.path) ?? 0,
			dynamicSites: edges.filter(
				(edge) => edge.from === module.path && (edge.kind === "dynamic-import" || edge.kind === "require"),
			).length,
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
	const runtimeEdges = edges
		.filter((edge) => edge.runtime && edge.to !== null)
		.map((edge) => ({ from: edge.from, to: edge.to ?? "" }));
	const allEdges = edges.filter((edge) => edge.to !== null).map((edge) => ({ from: edge.from, to: edge.to ?? "" }));
	const uniqueEdges = (values: readonly { from: string; to: string }[]): { from: string; to: string }[] =>
		[...new Map(values.map((edge) => [`${edge.from}\u0000${edge.to}`, edge])).values()].sort((a, b) =>
			`${a.from}\u0000${a.to}`.localeCompare(`${b.from}\u0000${b.to}`),
		);
	const packageGraph = packageRecords(root);
	const packageNodes = packageGraph.packages.map((record) => record.id);
	const packageRuntimeCycles = stronglyConnectedComponents(packageNodes, packageGraph.runtimeEdges);
	const packageAllCycles = stronglyConnectedComponents(packageNodes, packageGraph.allEdges);
	const runtimeCycles = stronglyConnectedComponents(
		sourceModules.map((module) => module.path),
		uniqueEdges(runtimeEdges),
	);
	const typeCycles = stronglyConnectedComponents(
		sourceModules.map((module) => module.path),
		uniqueEdges(allEdges),
	);
	return {
		generatedFrom: GENERATED_FROM,
		sourceRoot: relativePath(root, sourceRoot) || ".",
		sourceFiles: sourceModules,
		sourceEdges: edges.sort((a, b) => a.id.localeCompare(b.id)),
		computedLoads: computedLoads.sort((a, b) => a.id.localeCompare(b.id)),
		generatedArtifacts,
		generatedArtifactManifest,
		runtimeCycles,
		typeCycles,
		packages: packageGraph.packages,
		packageRuntimeEdges: packageGraph.runtimeEdges,
		packageAllEdges: packageGraph.allEdges,
		summary: {
			files: sourceModules.length,
			lines: sourceModules.reduce((total, module) => total + module.lines, 0),
			logicalStatements: sourceModules.reduce((total, module) => total + module.logicalStatements, 0),
			runtimeEdges: runtimeEdges.length,
			allEdges: allEdges.length,
			unresolvedEdges: edges.filter((edge) => edge.to === null).length,
			dynamicLiteralSites: edges.filter((edge) => edge.kind === "dynamic-import" || edge.kind === "require").length,
			computedLoads: computedLoads.length,
			runtimeCycles: runtimeCycles.length,
			typeCycles: typeCycles.length,
			packages: packageGraph.packages.length,
			packageRuntimeCycles: packageRuntimeCycles.length,
			packageAllCycles: packageAllCycles.length,
			typeEscapes: sourceModules.reduce((total, module) => total + module.typeEscapes, 0),
		},
	};
}

export function renderReport(inventory: ArchitectureInventory): string {
	const topModules = [...inventory.sourceFiles]
		.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
		.slice(0, 20);
	const topFanIn = [...inventory.sourceFiles]
		.sort((a, b) => b.runtimeFanIn - a.runtimeFanIn || a.path.localeCompare(b.path))
		.slice(0, 10);
	const cycleLines = (cycles: readonly Cycle[]): string =>
		cycles.length === 0
			? "- None"
			: cycles.map((cycle) => `- \`${cycle.id}\`: ${cycle.nodes.map((node) => `\`${node}\``).join(" → ")}`).join("\n");
	const computedLines =
		inventory.computedLoads.length === 0
			? "- None"
			: inventory.computedLoads
					.map((load) => `- \`${load.id}\` ${load.path}:${load.line} (${load.kind}) \`${load.expression}\``)
					.join("\n");
	const artifactLines =
		inventory.generatedArtifacts.length === 0
			? "- None"
			: inventory.generatedArtifacts
					.map(
						(artifact) =>
							`- \`${artifact.path}\`: ${artifact.lines} lines, ${artifact.bytes} bytes (${artifact.reason})`,
					)
					.join("\n");
	const manifestLines = inventory.generatedArtifactManifest
		.map(
			(artifact) =>
				`- \`${artifact.path}\`: owner \`${artifact.owner}\`, source \`${artifact.source}\`, generated by \`${artifact.generatedBy}\``,
		)
		.join("\n");
	const measuredArtifactPaths = new Set(
		inventory.generatedArtifacts.filter((artifact) => artifact.materialized).map((artifact) => artifact.path),
	);
	const measuredManifestCount = inventory.generatedArtifactManifest.filter((artifact) =>
		measuredArtifactPaths.has(artifact.path),
	).length;
	const missingManifestLines = inventory.generatedArtifactManifest
		.filter((artifact) => !measuredArtifactPaths.has(artifact.path))
		.map((artifact) => `- \`${artifact.path}\``)
		.join("\n");
	return `# Architecture contract baseline

Generated by \`${GENERATED_FROM}\`. This report is an inventory, not a claim that existing debt is healthy. The baseline is structural and deterministic: line numbers are display metadata, while module, edge, cycle, and computed-load identities are hashes of normalized syntax and sorted node sets. Manifested artifact sizes are report-only and canonicalized out of the committed baseline so clean and build-materialized trees compare identically.

## Inventory

- Source files: ${inventory.summary.files.toLocaleString("en-US")}
- Counted lines: ${inventory.summary.lines.toLocaleString("en-US")}
- Logical statements: ${inventory.summary.logicalStatements.toLocaleString("en-US")}
- Source edges: ${inventory.summary.allEdges.toLocaleString("en-US")} total, ${inventory.summary.runtimeEdges.toLocaleString("en-US")} runtime
- Unresolved source edges retained in the baseline: ${inventory.summary.unresolvedEdges.toLocaleString("en-US")}
- Literal dynamic import/require sites: ${inventory.summary.dynamicLiteralSites.toLocaleString("en-US")}
- Computed runtime loads: ${inventory.summary.computedLoads.toLocaleString("en-US")}
- Workspace packages: ${inventory.summary.packages}
- Workspace package edges: ${inventory.packageAllEdges.length} total, ${inventory.packageRuntimeEdges.length} runtime
- Type escapes tracked: ${inventory.summary.typeEscapes}
- Generated/bundled artifacts measured separately: ${inventory.generatedArtifacts.length} total; ${measuredManifestCount} of ${inventory.generatedArtifactManifest.length} manifested outputs found

## Cycle ledger

Runtime source SCCs: ${inventory.summary.runtimeCycles}

${cycleLines(inventory.runtimeCycles)}

Type-inclusive source SCCs: ${inventory.summary.typeCycles}

${cycleLines(inventory.typeCycles)}

Workspace package runtime SCCs: ${inventory.summary.packageRuntimeCycles}
Workspace package all-dependency SCCs: ${inventory.summary.packageAllCycles}

## Computed-load ledger

Literal AST resolution intentionally does not guess configured runtime paths. These entries are the explicit residual contract that later work must delete or narrow.

${computedLines}

## Generated and bundled artifacts

These files are excluded from the handwritten source graph. Their source ownership and size remain visible here so generated output cannot hide module growth.

${artifactLines}

Manifested generated outputs:

${manifestLines}

Manifested outputs not present in the scanned source tree:

${missingManifestLines || "- None"}

## Largest source modules

| path | lines | logical statements | exports | mutable top-level | runtime fan-in modules | runtime fan-in callsites | runtime fan-out modules | runtime fan-out callsites | layer |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
${topModules.map((module) => `| \`${module.path}\` | ${module.lines} | ${module.logicalStatements} | ${module.exports} | ${module.topLevelMutableBindings} | ${module.runtimeFanIn} | ${module.runtimeCallsitesIn} | ${module.runtimeFanOut} | ${module.runtimeCallsitesOut} | ${module.layer} |`).join("\n")}

## Highest runtime fan-in

${topFanIn.map((module) => `- \`${module.path}\`: ${module.runtimeFanIn} incoming modules, ${module.runtimeCallsitesIn} incoming callsites`).join("\n")}

## Ratchet interpretation

- Runtime source and workspace package cycles have a zero budget.
- Type-inclusive SCCs, computed loads, forbidden layer edges, and ambient routes/state.ts importers are deletion-only ledgers.
- Handwritten module logical statements, public exports, and tracked type escapes may not grow; new handwritten modules are capped at 500 logical statements.
- Generated/bundled files are excluded only when their ownership is proven by the generated-artifact manifest.
- bun run audit:architecture compares this inventory with the committed baseline and is the blocking pull-request architecture gate.
`;
}

export function loadBaseline(path = BASELINE_PATH): ArchitectureInventory {
	const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as BaselineFile;
	if (parsed.version !== 1 || parsed.inventory === undefined || !Array.isArray(parsed.inventory.sourceFiles))
		throw new Error(`Invalid architecture baseline: ${path}`);
	return canonicalizeBaselineInventory(parsed.inventory);
}

export function canonicalizeBaselineInventory(inventory: ArchitectureInventory): ArchitectureInventory {
	return {
		...inventory,
		generatedArtifacts: inventory.generatedArtifacts.map((artifact) => ({
			...artifact,
			lines: 0,
			bytes: 0,
			materialized: false,
		})),
	};
}

const NEW_MODULE_STATEMENT_LIMIT = 500;

function edgeKey(edge: Pick<SourceEdge, "from" | "to" | "kind" | "runtime">): string {
	return `${edge.from}\u0000${edge.to ?? ""}\u0000${edge.kind}\u0000${edge.runtime ? "runtime" : "type"}`;
}

function sourceLayerViolation(edge: SourceEdge, modules: ReadonlyMap<string, SourceModule>): string | null {
	if (edge.to === null) return null;
	const from = modules.get(edge.from);
	const to = modules.get(edge.to);
	if (from === undefined || to === undefined || from.layer === "composition-root") return null;
	const importsRoute = to.layer === "routes" && from.layer !== "routes";
	const importsCompositionRoot = to.path.endsWith("/daemon.ts");
	const importsDashboard = to.path.includes("surfaces/dashboard/") && !from.path.includes("surfaces/dashboard/");
	const importsConcreteRegistry =
		(to.path.endsWith("/source-providers.ts") || to.path.endsWith("/providers/registry.ts")) &&
		from.layer !== "adapters";
	if (!importsRoute && !importsCompositionRoot && !importsDashboard && !importsConcreteRegistry) return null;
	return `${edge.from} -> ${edge.to} (${edge.kind})`;
}

function forbiddenLayerEdges(inventory: ArchitectureInventory): readonly string[] {
	const modules = new Map(inventory.sourceFiles.map((module) => [module.path, module]));
	return [
		...new Set(
			inventory.sourceEdges.flatMap((edge) => {
				const violation = sourceLayerViolation(edge, modules);
				return violation === null ? [] : [violation];
			}),
		),
	].sort((a, b) => a.localeCompare(b));
}

function routeStateImporters(inventory: ArchitectureInventory): readonly string[] {
	return [
		...new Set(
			inventory.sourceEdges
				.filter((edge) => edge.to?.endsWith("platform/daemon/src/routes/state.ts") === true)
				.map((edge) => edge.from),
		),
	].sort((a, b) => a.localeCompare(b));
}

function cycleNodeSets(cycles: readonly Cycle[]): readonly ReadonlySet<string>[] {
	return cycles.map((cycle) => new Set(cycle.nodes));
}

export function compareArchitectureRatchet(
	current: ArchitectureInventory,
	baseline: ArchitectureInventory,
): readonly string[] {
	const findings: string[] = [];
	if (current.runtimeCycles.length > 0 || current.summary.runtimeCycles > 0)
		findings.push("runtime source cycles exceed the zero budget");
	if (current.summary.packageRuntimeCycles > 0 || current.summary.packageAllCycles > 0)
		findings.push("workspace package dependency cycles exceed the zero budget");

	const baselineTypeCycles = cycleNodeSets(baseline.typeCycles);
	for (const cycle of current.typeCycles) {
		const nodes = new Set(cycle.nodes);
		if (!baselineTypeCycles.some((existing) => [...nodes].every((node) => existing.has(node)))) {
			findings.push(`new or expanded type-inclusive SCC ${cycle.id}: ${cycle.nodes.join(", ")}`);
		}
	}

	const baselineComputedLoads = new Set(baseline.computedLoads.map((load) => load.id));
	for (const load of current.computedLoads) {
		if (!baselineComputedLoads.has(load.id)) findings.push(`new computed runtime load ${load.path}:${load.line}`);
	}

	const baselineModules = new Map(baseline.sourceFiles.map((module) => [module.path, module]));
	for (const module of current.sourceFiles) {
		const previous = baselineModules.get(module.path);
		if (previous === undefined) {
			if (module.logicalStatements > NEW_MODULE_STATEMENT_LIMIT)
				findings.push(
					`new handwritten module ${module.path} has ${module.logicalStatements} logical statements (limit ${NEW_MODULE_STATEMENT_LIMIT})`,
				);
			if (module.typeEscapes > 0) findings.push(`new type escapes in ${module.path}: ${module.typeEscapes}`);
			continue;
		}
		if (module.logicalStatements > previous.logicalStatements)
			findings.push(
				`module growth in ${module.path}: ${previous.logicalStatements} -> ${module.logicalStatements} logical statements`,
			);
		if (module.exports > previous.exports)
			findings.push(`public-surface growth in ${module.path}: ${previous.exports} -> ${module.exports} exports`);
		if (module.typeEscapes > (previous.typeEscapes ?? 0))
			findings.push(`type-escape growth in ${module.path}: ${previous.typeEscapes ?? 0} -> ${module.typeEscapes}`);
	}

	const currentLayerEdges = new Set(forbiddenLayerEdges(current));
	const baselineLayerEdges = new Set(forbiddenLayerEdges(baseline));
	for (const edge of currentLayerEdges) {
		if (!baselineLayerEdges.has(edge)) findings.push(`new forbidden source-layer edge ${edge}`);
	}
	const currentStateImporters = new Set(routeStateImporters(current));
	const baselineStateImporters = new Set(routeStateImporters(baseline));
	for (const importer of currentStateImporters) {
		if (!baselineStateImporters.has(importer)) findings.push(`new routes/state.ts importer ${importer}`);
	}

	const baselineEdges = new Set(baseline.sourceEdges.map(edgeKey));
	for (const edge of current.sourceEdges) {
		if (edge.to !== null && edge.kind === "require" && !baselineEdges.has(edgeKey(edge))) {
			findings.push(`new runtime require edge ${edge.from} -> ${edge.to}`);
		}
	}
	return findings.sort((a, b) => a.localeCompare(b));
}

export function writeBaseline(
	inventory: ArchitectureInventory,
	baselinePath = BASELINE_PATH,
	reportPath = REPORT_PATH,
): void {
	const output: BaselineFile = {
		version: 1,
		generatedFrom: GENERATED_FROM,
		inventory: canonicalizeBaselineInventory(inventory),
	};
	writeFileSync(resolve(baselinePath), `${JSON.stringify(output, null, "\t")}\n`);
	writeFileSync(resolve(reportPath), renderReport(inventory));
}

function main(): void {
	const inventory = analyzeSourceTree();
	const writesBaseline = process.argv.includes("--write-baseline");
	if (writesBaseline) writeBaseline(inventory);
	console.log(`Architecture source files: ${inventory.summary.files}`);
	console.log(`Source edges: ${inventory.summary.allEdges} total, ${inventory.summary.runtimeEdges} runtime`);
	console.log(`Computed loads: ${inventory.summary.computedLoads}`);
	console.log(
		`Source cycles: ${inventory.summary.runtimeCycles} runtime, ${inventory.summary.typeCycles} type-inclusive`,
	);
	console.log(`Workspace packages: ${inventory.summary.packages}`);
	if (writesBaseline) {
		console.log(`Baseline written: ${relativePath(ROOT, BASELINE_PATH)}`);
		return;
	}
	const findings = compareArchitectureRatchet(inventory, loadBaseline());
	if (findings.length > 0) {
		console.error("Architecture ratchet violations:");
		for (const finding of findings) console.error(`- ${finding}`);
		process.exitCode = 1;
	} else {
		console.log("Architecture ratchet: baseline respected");
	}
}

if (import.meta.main) main();
