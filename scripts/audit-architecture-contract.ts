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
	readonly protectedGeneratedArtifactManifest?: readonly GeneratedArtifactManifestEntry[];
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

interface GeneratedGeneratorPaths {
	readonly outputs: ReadonlySet<string>;
	readonly inputs: ReadonlySet<string>;
}

export interface AuditOptions {
	readonly root?: string;
	readonly sourceRoot?: string;
	readonly validateGeneratedArtifacts?: boolean;
}

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "scripts/architecture-baseline.json");
const REPORT_PATH = join(ROOT, "docs/architecture-audit.md");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".cts", ".mts"] as const;
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".cts", ".mts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const ASSIGNMENT_OPERATORS = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
	">>>=",
	"**=",
	"&&=",
	"||=",
	"??=",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
	".git",
	"node_modules",
	"dist",
	"fixtures",
	"coverage",
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
		!/(?:\.test|\.bench)\.(?:ts|tsx|cts|mts)$/.test(normalized) &&
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
	return hasGeneratedMarker(source) ? "generated-marker" : null;
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

function headerEndPosition(source: string): number {
	let lines = 1;
	for (let position = 0; position < source.length; position += 1) {
		if (source[position] !== "\n") continue;
		lines += 1;
		if (lines > 12) return position;
	}
	return source.length;
}

function actualCommentTrivia(source: string, limitToHeader = false): readonly string[] {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
	const limit = limitToHeader ? headerEndPosition(source) : source.length;
	const comments: string[] = [];
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
		const start = scanner.getTokenPos();
		if (start >= limit) continue;
		const lineStart = source.lastIndexOf("\n", start - 1) + 1;
		if (source.slice(lineStart, start).trim().length > 0) continue;
		comments.push(source.slice(start, Math.min(scanner.getTextPos(), limit)));
	}
	return comments;
}

function generatedHeader(source: string): string {
	return source.slice(0, headerEndPosition(source));
}

function hasGeneratedMarker(source: string): boolean {
	return actualCommentTrivia(source, true).some((comment) =>
		/AUTO-GENERATED FILE|Auto-generated by|AUTO-GENERATED from/.test(comment),
	);
}

function hasExactProvenanceToken(source: string, key: "source" | "generatedBy", value: string): boolean {
	const expected = `Architecture provenance: ${key}=${value}`;
	return actualCommentTrivia(source).some((comment) =>
		comment.split("\n").some((line) => {
			let content = line.trim();
			content = content
				.replace(/^\/\*+\s?/, "")
				.replace(/^\/\/\s?/, "")
				.replace(/^#\s?/, "");
			content = content
				.replace(/^\*\s?/, "")
				.replace(/\s?\*\/$/, "")
				.trim();
			return content === expected;
		}),
	);
}

function generatedGeneratorPaths(root: string, generatorPath: string): GeneratedGeneratorPaths {
	const source = readFileSync(generatorPath, "utf8");
	const sourceFile = ts.createSourceFile(generatorPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const outputs = new Set<string>();
	const inputs = new Set<string>();

	const staticPath = (
		expression: ts.Expression,
		scope: StaticScope,
		resolving = new Set<StaticBinding>(),
	): string | null => {
		const unwrapped = unwrapExpression(expression);
		if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
		if (ts.isIdentifier(unwrapped)) {
			const resolved = resolveBinding(scope, unwrapped.text);
			if (resolved === undefined) return unwrapped.text === "__dirname" ? dirname(generatorPath) : null;
			const { binding, scope: definingScope } = resolved;
			if (binding.initializer === null || resolving.has(binding)) return null;
			const nextResolving = new Set(resolving);
			nextResolving.add(binding);
			return staticPath(binding.initializer, definingScope, nextResolving);
		}
		if (
			ts.isPropertyAccessExpression(unwrapped) &&
			unwrapped.name.text === "url" &&
			ts.isMetaProperty(unwrapped.expression) &&
			unwrapped.expression.getText(sourceFile) === "import.meta"
		)
			return generatorPath;
		if (ts.isNewExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && unwrapped.expression.text === "URL") {
			if (resolveBinding(scope, "URL") !== undefined) return null;
			const argumentsList = unwrapped.arguments ?? [];
			const urlArgument = argumentsList[0];
			const baseArgument = argumentsList[1];
			const urlExpression = urlArgument === undefined ? null : unwrapExpression(urlArgument);
			const baseExpression = baseArgument === undefined ? null : unwrapExpression(baseArgument);
			const urlValue =
				urlExpression !== null &&
				(ts.isStringLiteral(urlExpression) || ts.isNoSubstitutionTemplateLiteral(urlExpression))
					? urlExpression.text
					: null;
			const isImportMetaUrl =
				baseExpression !== null &&
				ts.isPropertyAccessExpression(baseExpression) &&
				baseExpression.name.text === "url" &&
				ts.isMetaProperty(baseExpression.expression) &&
				baseExpression.expression.getText(sourceFile) === "import.meta";
			if (urlValue === null || !isImportMetaUrl || urlValue.startsWith("/") || /[?#%\\:]/.test(urlValue)) return null;
			return urlValue === "" ? generatorPath : resolve(dirname(generatorPath), urlValue);
		}
		if (!ts.isCallExpression(unwrapped)) return null;
		const callee = unwrapExpression(unwrapped.expression);
		const calleeName = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: null;
		const helper =
			calleeName === null
				? null
				: ts.isIdentifier(callee)
					? canonicalPathHelper(scope, callee.text, calleeName)
					: ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
						? isCanonicalPathHelperName(calleeName) &&
							((calleeName === "fileURLToPath" && isCanonicalUrlNamespace(scope, callee.expression.text)) ||
								(calleeName !== "fileURLToPath" && isCanonicalPathNamespace(scope, callee.expression.text)))
							? calleeName
							: null
						: null;
		if (helper === null || !isCanonicalPathHelperName(helper)) return null;
		const values: string[] = [];
		const argumentsValue = unwrapped.arguments.map((argument) => staticPath(argument, scope, resolving));
		for (const value of argumentsValue) {
			if (value === null) return null;
			values.push(value);
		}
		if (helper === "join") return join(...values);
		if (helper === "resolve") return resolve(...values);
		if (helper === "dirname") return dirname(values[0] ?? generatorPath);
		const argument = unwrapped.arguments[0];
		return argument === undefined ? null : staticPath(argument, scope, resolving);
	};
	const visit = (node: ts.Node, scope: StaticScope): void => {
		let currentScope = scope;
		if (isFunctionLike(node)) {
			currentScope = { parent: scope, bindings: new Map(), isVarScope: true };
			for (const parameter of node.parameters) bindPattern(currentScope, parameter.name, parameter.initializer ?? null);
			predeclareVarBindings(node, currentScope);
			predeclareFunctionBindings(node, currentScope);
		} else if (
			ts.isSourceFile(node) ||
			ts.isBlock(node) ||
			ts.isModuleDeclaration(node) ||
			ts.isModuleBlock(node) ||
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
			if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node))
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
			bindPattern(bindingScope, node.name, node.initializer ?? null);
		}
		if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.getText(sourceFile))) {
			if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
				assignBindingTarget(currentScope, node.left, node.right);
			else invalidateAssignmentTarget(currentScope, node.left);
		}
		if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
			assignBindingTarget(currentScope, node.initializer, null);
		if (
			ts.isPrefixUnaryExpression(node) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
			ts.isIdentifier(node.operand)
		)
			invalidateBinding(currentScope, node.operand.text);
		if (
			ts.isPostfixUnaryExpression(node) &&
			ts.isIdentifier(node.operand) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
		)
			invalidateBinding(currentScope, node.operand.text);
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
					const output = staticPath(outputArgument, currentScope);
					if (output !== null) outputs.add(resolve(root, output));
				}
			}
			const isReadFileSync =
				(ts.isIdentifier(callee) && isCanonicalReadFileSync(currentScope, callee.text)) ||
				(ts.isPropertyAccessExpression(callee) &&
					ts.isIdentifier(callee.expression) &&
					callee.name.text === "readFileSync" &&
					isCanonicalFsNamespace(currentScope, callee.expression.text));
			if (isReadFileSync) {
				const inputArgument = node.arguments[0];
				if (inputArgument !== undefined) {
					const input = staticPath(inputArgument, currentScope);
					if (input !== null) inputs.add(resolve(root, input));
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
	return { outputs, inputs };
}

function generatedSourceCandidates(root: string, inputPaths: ReadonlySet<string>): ReadonlySet<string> {
	const candidates = new Set<string>();
	for (const inputPath of inputPaths) {
		const input = relativePath(root, inputPath);
		if (input.startsWith("../") || input === ".." || input.length === 0) continue;
		candidates.add(input);
		const distMarker = "/dist/";
		const distIndex = input.indexOf(distMarker);
		if (distIndex > 0) candidates.add(input.slice(0, distIndex));
		const parent = dirname(input);
		if (parent !== ".") candidates.add(normalizedPath(parent));
	}
	return candidates;
}

function packageOwner(root: string, path: string): string | null {
	let directory = dirname(path);
	while (true) {
		const packagePath = join(directory, "package.json");
		if (existsSync(packagePath)) {
			try {
				const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
				if (typeof packageJson.name === "string") return packageJson.name;
			} catch {
				return null;
			}
		}
		if (directory === root) return null;
		const parent = dirname(directory);
		if (parent === directory || !parent.startsWith(root)) return null;
		directory = parent;
	}
}

function protectedGeneratorPaths(root: string): readonly string[] {
	return walk(root, (path) => {
		const normalized = relativePath(root, path);
		const segments = normalized.split("/");
		const fileName = basename(path).toLowerCase();
		return (
			SOURCE_EXTENSIONS.includes(extname(path) as (typeof SOURCE_EXTENSIONS)[number]) &&
			segments.includes("scripts") &&
			/(?:generate|embed|codegen|bundle)/.test(fileName)
		);
	});
}

function loadProtectedGeneratedArtifactManifest(root: string): readonly GeneratedArtifactManifestEntry[] {
	const manifestPath = join(root, "scripts/architecture-generated-artifacts.json");
	if (existsSync(manifestPath)) return loadGeneratedArtifactManifest(root);
	const entries: GeneratedArtifactManifestEntry[] = [];
	for (const generatorPath of protectedGeneratorPaths(root)) {
		let paths: GeneratedGeneratorPaths;
		try {
			paths = generatedGeneratorPaths(root, generatorPath);
		} catch {
			continue;
		}
		const owner = packageOwner(root, generatorPath);
		if (owner === null) continue;
		const sources = [...generatedSourceCandidates(root, paths.inputs)].filter((source) =>
			existsSync(join(root, source)),
		);
		if (sources.length === 0) continue;
		for (const outputPath of paths.outputs) {
			const output = relativePath(root, outputPath);
			if (output.startsWith("../") || output === ".." || output.length === 0) continue;
			for (const source of sources) {
				entries.push({
					path: output,
					owner,
					source,
					generatedBy: relativePath(root, generatorPath),
				});
			}
		}
	}
	return [...new Map(entries.map((entry) => [`${entry.path}\u0000${entry.source}`, entry])).values()].sort((a, b) =>
		`${a.path}\u0000${a.source}\u0000${a.generatedBy}`.localeCompare(
			`${b.path}\u0000${b.source}\u0000${b.generatedBy}`,
		),
	);
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
		const generatorPaths = generatedGeneratorPaths(root, generatorPath);
		if (!generatorPaths.outputs.has(artifactPath)) {
			throw new Error(
				`Generated artifact generator ${artifact.generatedBy} does not write its exact output ${artifact.path}`,
			);
		}
		if (!hasExactProvenanceToken(generatorSource, "source", artifact.source)) {
			throw new Error(
				`Generated artifact generator ${artifact.generatedBy} does not identify its source ${artifact.source}`,
			);
		}
		if (existsSync(artifactPath)) {
			if (!statSync(artifactPath).isFile()) throw new Error(`Generated artifact path is not a file: ${artifact.path}`);
			const artifactSource = readFileSync(artifactPath, "utf8");
			if (
				!hasGeneratedMarker(artifactSource) ||
				!hasExactProvenanceToken(generatedHeader(artifactSource), "generatedBy", artifact.generatedBy)
			)
				throw new Error(
					`Generated artifact ${artifact.path} is materialized without a provenance header naming ${artifact.generatedBy}`,
				);
		}
		if (!generatedSourceCandidates(root, generatorPaths.inputs).has(artifact.source)) {
			throw new Error(
				`Generated artifact generator ${artifact.generatedBy} does not read its declared source ${artifact.source}`,
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

type CanonicalPathHelper = "join" | "resolve" | "dirname" | "fileURLToPath";

function isCanonicalPathHelperName(name: string): name is CanonicalPathHelper {
	return name === "join" || name === "resolve" || name === "dirname" || name === "fileURLToPath";
}

interface StaticBinding {
	readonly initializer: ts.Expression | null;
	readonly canonicalCreateRequire: boolean;
	readonly canonicalCreateRequireFactory?: boolean;
	readonly invalidatedCreateRequireFactory?: boolean;
	readonly canonicalCreateRequireResult?: boolean;
	readonly invalidatedCreateRequireResult?: boolean;
	readonly canonicalAmbientRequire?: boolean;
	readonly ambientRequireLike?: boolean;
	readonly invalidatedAmbientRequire?: boolean;
	readonly canonicalModuleNamespace?: boolean;
	readonly canonicalWriteFileSync?: boolean;
	readonly canonicalReadFileSync?: boolean;
	readonly canonicalFsNamespace?: boolean;
	readonly canonicalPathHelper?: CanonicalPathHelper;
	readonly canonicalUrlHelper?: "fileURLToPath";
	readonly canonicalPathNamespace?: boolean;
	readonly canonicalUrlNamespace?: boolean;
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

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return null;
}

function objectLiteralPropertyValue(
	initializer: ts.ObjectLiteralExpression,
	key: string,
): ts.Expression | null | undefined {
	let uncertain = false;
	let value: ts.Expression | undefined;
	for (const property of initializer.properties) {
		if (ts.isSpreadAssignment(property)) {
			uncertain = true;
			continue;
		}
		if (ts.isShorthandPropertyAssignment(property)) {
			if (property.name.text === key) value = property.name;
			continue;
		}
		if (!ts.isPropertyAssignment(property)) {
			uncertain = true;
			continue;
		}
		const propertyKey = propertyNameText(property.name);
		if (propertyKey === key) value = property.initializer;
		if (propertyKey === null) uncertain = true;
	}
	if (uncertain) return null;
	return value;
}

function bindingElementInitializer(
	initializer: ts.Expression | null,
	element: ts.BindingElement,
	index: number,
): ts.Expression | null {
	if (initializer === null) return null;
	const unwrapped = unwrapExpression(initializer);
	if (ts.isArrayLiteralExpression(unwrapped)) {
		const sourceElement = unwrapped.elements[index];
		if (sourceElement === undefined) return element.initializer ?? null;
		if (ts.isOmittedExpression(sourceElement) || ts.isSpreadElement(sourceElement)) return null;
		return sourceElement;
	}
	if (!ts.isObjectLiteralExpression(unwrapped)) return null;
	const propertyName = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : null);
	if (propertyName === null) return null;
	const key = propertyNameText(propertyName);
	if (key === null) return null;
	const value = objectLiteralPropertyValue(unwrapped, key);
	return value === undefined ? (element.initializer ?? null) : value;
}

function bindPattern(
	scope: StaticScope,
	name: ts.BindingName,
	initializer: ts.Expression | null,
	canonicalCreateRequire = false,
	canonicalWriteFileSync = false,
	canonicalFsNamespace = false,
	canonicalModuleNamespace = false,
	canonicalAmbientRequire = false,
	ambientRequireLike = canonicalAmbientRequire,
	resolutionScope: StaticScope = scope,
): void {
	if (ts.isIdentifier(name)) {
		const canonicalFactory =
			canonicalCreateRequire ||
			(initializer !== null && isCanonicalCreateRequireFactoryExpression(initializer, resolutionScope));
		const canonicalResult =
			initializer !== null && isCanonicalCreateRequireResultExpression(initializer, resolutionScope);
		const invalidatedResult =
			initializer !== null && isPotentialInvalidatedCreateRequireResultExpression(initializer, resolutionScope);
		const inferredCanonicalAmbientRequire =
			canonicalAmbientRequire ||
			(initializer !== null && isCanonicalAmbientRequireExpression(initializer, resolutionScope));
		const potentialAmbientRequire =
			ambientRequireLike || (initializer !== null && isPotentialAmbientRequireExpression(initializer, resolutionScope));
		scope.bindings.set(name.text, {
			initializer,
			canonicalCreateRequire: canonicalCreateRequire,
			canonicalCreateRequireFactory: canonicalFactory,
			canonicalCreateRequireResult: canonicalResult,
			invalidatedCreateRequireResult: invalidatedResult,
			canonicalModuleNamespace,
			canonicalWriteFileSync,
			canonicalFsNamespace,
			canonicalAmbientRequire: inferredCanonicalAmbientRequire,
			ambientRequireLike: potentialAmbientRequire,
		});
		return;
	}
	for (const [index, element] of name.elements.entries()) {
		if (ts.isOmittedExpression(element)) continue;
		if (ts.isBindingElement(element)) {
			const propertyName = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : null);
			const unwrappedInitializer = initializer === null ? null : unwrapExpression(initializer);
			const isGlobalThisRequireShape =
				unwrappedInitializer !== null &&
				propertyName !== null &&
				propertyNameText(propertyName) === "require" &&
				ts.isIdentifier(unwrappedInitializer) &&
				unwrappedInitializer.text === "globalThis";
			const isGlobalThisRequire =
				isGlobalThisRequireShape && resolveBinding(resolutionScope, "globalThis") === undefined;
			const childInitializer = isGlobalThisRequireShape ? null : bindingElementInitializer(initializer, element, index);
			bindPattern(
				scope,
				element.name,
				childInitializer,
				false,
				false,
				false,
				false,
				isGlobalThisRequire,
				isGlobalThisRequireShape,
				resolutionScope,
			);
		}
	}
}

function bindDeclaration(scope: StaticScope, declaration: ts.Declaration): void {
	if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)) {
		const flags = declaration.parent.flags;
		const isVar = (flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0;
		bindPattern(isVar ? nearestVarScope(scope) : scope, declaration.name, declaration.initializer ?? null);
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
		if (
			candidate !== node &&
			(isFunctionLike(candidate) || ts.isModuleDeclaration(candidate) || ts.isModuleBlock(candidate))
		)
			return;
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
				ts.isForOfStatement(candidate) ||
				ts.isModuleDeclaration(candidate) ||
				ts.isModuleBlock(candidate))
		) {
			if (ts.isFunctionDeclaration(candidate) || ts.isClassDeclaration(candidate) || ts.isEnumDeclaration(candidate))
				bindDeclaration(scope, candidate);
			return;
		}
		if (ts.isImportDeclaration(candidate) && candidate.importClause !== undefined) {
			const clause = candidate.importClause;
			const moduleSpecifier = ts.isStringLiteral(candidate.moduleSpecifier) ? candidate.moduleSpecifier.text : null;
			const isNodeFs = moduleSpecifier === "node:fs" || moduleSpecifier === "fs";
			const isNodePath = moduleSpecifier === "node:path" || moduleSpecifier === "path";
			const isNodeUrl = moduleSpecifier === "node:url" || moduleSpecifier === "url";
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
					canonicalModuleNamespace: moduleSpecifier === "node:module" || moduleSpecifier === "module",
					canonicalFsNamespace: isNodeFs,
					canonicalReadFileSync: false,
					canonicalPathNamespace: isNodePath,
					canonicalUrlNamespace: isNodeUrl,
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
						canonicalReadFileSync: isNodeFs && importedName === "readFileSync",
						canonicalPathHelper: isNodePath && isCanonicalPathHelperName(importedName) ? importedName : undefined,
						canonicalUrlHelper: isNodeUrl && importedName === "fileURLToPath" ? importedName : undefined,
						canonicalUrlNamespace: false,
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

function isCanonicalCreateRequire(scope: StaticScope, name: string, resolving = new Set<string>()): boolean {
	if (resolving.has(name)) return false;
	const resolved = resolveBinding(scope, name);
	if (resolved === undefined) return false;
	if (resolved.binding.invalidatedCreateRequireFactory === true) return false;
	if (resolved.binding.canonicalCreateRequire) return true;
	const initializer = resolved.binding.initializer;
	if (initializer === null) return false;
	const unwrapped = unwrapExpression(initializer);
	if (ts.isPropertyAccessExpression(unwrapped))
		return (
			ts.isIdentifier(unwrapped.expression) &&
			unwrapped.name.text === "createRequire" &&
			isCanonicalModuleNamespace(resolved.scope, unwrapped.expression.text)
		);
	if (!ts.isIdentifier(unwrapped)) return false;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return isCanonicalCreateRequire(resolved.scope, unwrapped.text, nextResolving);
}

function ambientRequireBindCall(expression: ts.Expression): ts.CallExpression | null {
	const unwrapped = unwrapExpression(expression);
	if (!ts.isCallExpression(unwrapped)) return null;
	const callee = unwrapExpression(unwrapped.expression);
	if (
		!ts.isPropertyAccessExpression(callee) ||
		callee.name.text !== "bind" ||
		callee.expression === undefined ||
		unwrapped.arguments.length !== 1 ||
		unwrapped.arguments[0]?.kind !== ts.SyntaxKind.NullKeyword
	)
		return null;
	return unwrapped;
}

function isAmbientRequireShape(expression: ts.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	if (ts.isIdentifier(unwrapped) && unwrapped.text === "require") return true;
	if (
		ts.isPropertyAccessExpression(unwrapped) &&
		unwrapped.name.text === "require" &&
		ts.isIdentifier(unwrapped.expression) &&
		unwrapped.expression.text === "globalThis"
	)
		return true;
	const bound = ambientRequireBindCall(unwrapped);
	return bound === null
		? false
		: isAmbientRequireShape(unwrapExpression((bound.expression as ts.PropertyAccessExpression).expression));
}

function isPotentialAmbientRequireExpression(
	expression: ts.Expression,
	scope: StaticScope,
	resolving = new Set<StaticBinding>(),
): boolean {
	const unwrapped = unwrapExpression(expression);
	if (isAmbientRequireShape(unwrapped)) return true;
	if (!ts.isIdentifier(unwrapped)) return false;
	return isPotentialAmbientRequire(scope, unwrapped.text, resolving);
}

function isPotentialAmbientRequire(scope: StaticScope, name: string, resolving = new Set<StaticBinding>()): boolean {
	const resolved = resolveBinding(scope, name);
	if (resolved === undefined) return false;
	const { binding, scope: definingScope } = resolved;
	if (binding.ambientRequireLike === true || binding.invalidatedAmbientRequire === true) return true;
	if (binding.initializer === null || resolving.has(binding)) return false;
	const nextResolving = new Set(resolving);
	nextResolving.add(binding);
	return isPotentialAmbientRequireExpression(binding.initializer, definingScope, nextResolving);
}

function isCanonicalAmbientRequireExpression(
	expression: ts.Expression,
	scope: StaticScope,
	resolving = new Set<StaticBinding>(),
): boolean {
	const unwrapped = unwrapExpression(expression);
	if (ts.isIdentifier(unwrapped) && unwrapped.text === "require") return resolveBinding(scope, "require") === undefined;
	if (
		ts.isPropertyAccessExpression(unwrapped) &&
		unwrapped.name.text === "require" &&
		ts.isIdentifier(unwrapped.expression) &&
		unwrapped.expression.text === "globalThis"
	)
		return resolveBinding(scope, "globalThis") === undefined;
	const bound = ambientRequireBindCall(unwrapped);
	if (bound !== null)
		return isCanonicalAmbientRequireExpression(
			unwrapExpression((bound.expression as ts.PropertyAccessExpression).expression),
			scope,
			resolving,
		);
	if (!ts.isIdentifier(unwrapped)) return false;
	return isCanonicalAmbientRequire(scope, unwrapped.text, resolving);
}

function isCanonicalAmbientRequire(scope: StaticScope, name: string, resolving = new Set<StaticBinding>()): boolean {
	const resolved = resolveBinding(scope, name);
	if (resolved === undefined) return false;
	const { binding, scope: definingScope } = resolved;
	if (binding.invalidatedAmbientRequire === true) return false;
	if (binding.canonicalAmbientRequire === true) return true;
	if (binding.initializer === null || resolving.has(binding)) return false;
	const nextResolving = new Set(resolving);
	nextResolving.add(binding);
	return isCanonicalAmbientRequireExpression(binding.initializer, definingScope, nextResolving);
}

function isCanonicalModuleNamespace(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalModuleNamespace === true;
}

function isCanonicalCreateRequireCall(expression: ts.Expression, scope: StaticScope): boolean {
	const callee = unwrapExpression(expression);
	if (ts.isIdentifier(callee)) return isCanonicalCreateRequire(scope, callee.text);
	return (
		ts.isPropertyAccessExpression(callee) &&
		ts.isIdentifier(callee.expression) &&
		callee.name.text === "createRequire" &&
		isCanonicalModuleNamespace(scope, callee.expression.text)
	);
}

function isCanonicalCreateRequireFactoryExpression(expression: ts.Expression, scope: StaticScope): boolean {
	const unwrapped = unwrapExpression(expression);
	if (ts.isIdentifier(unwrapped)) return isCanonicalCreateRequire(scope, unwrapped.text);
	return (
		ts.isPropertyAccessExpression(unwrapped) &&
		ts.isIdentifier(unwrapped.expression) &&
		unwrapped.name.text === "createRequire" &&
		isCanonicalModuleNamespace(scope, unwrapped.expression.text)
	);
}

function isCanonicalCreateRequireResultExpression(expression: ts.Expression, scope: StaticScope): boolean {
	const unwrapped = unwrapExpression(expression);
	if (ts.isCallExpression(unwrapped)) return isCanonicalCreateRequireCall(unwrapped.expression, scope);
	if (ts.isIdentifier(unwrapped)) return isCanonicalCreateRequireResult(scope, unwrapped.text);
	return false;
}

function isPotentialInvalidatedCreateRequireResultExpression(expression: ts.Expression, scope: StaticScope): boolean {
	const unwrapped = unwrapExpression(expression);
	if (ts.isCallExpression(unwrapped)) {
		const callee = unwrapExpression(unwrapped.expression);
		return (
			ts.isIdentifier(callee) && resolveBinding(scope, callee.text)?.binding.invalidatedCreateRequireFactory === true
		);
	}
	if (ts.isIdentifier(unwrapped)) return isPotentialInvalidatedCreateRequireResult(scope, unwrapped.text);
	return false;
}

function isPotentialInvalidatedCreateRequireResult(scope: StaticScope, name: string): boolean {
	const resolved = resolveBinding(scope, name);
	if (resolved === undefined || resolved.binding.initializer === null) return false;
	const initializer = resolved.binding.initializer;
	if (!ts.isCallExpression(initializer)) return false;
	const callee = unwrapExpression(initializer.expression);
	return (
		ts.isIdentifier(callee) &&
		resolveBinding(resolved.scope, callee.text)?.binding.invalidatedCreateRequireFactory === true
	);
}

function isCanonicalWriteFileSync(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalWriteFileSync === true;
}

function isCanonicalReadFileSync(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalReadFileSync === true;
}

function isCanonicalFsNamespace(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalFsNamespace === true;
}

function isCanonicalPathNamespace(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalPathNamespace === true;
}

function isCanonicalUrlNamespace(scope: StaticScope, name: string): boolean {
	return resolveBinding(scope, name)?.binding.canonicalUrlNamespace === true;
}

function canonicalPathHelper(scope: StaticScope, name: string, helper: string): CanonicalPathHelper | null {
	if (!isCanonicalPathHelperName(helper)) return null;
	const binding = resolveBinding(scope, name)?.binding;
	const canonicalHelper = helper === "fileURLToPath" ? binding?.canonicalUrlHelper : binding?.canonicalPathHelper;
	return canonicalHelper === helper ? helper : null;
}

function invalidateBinding(scope: StaticScope, name: string): void {
	const resolved = resolveBinding(scope, name);
	if (resolved === undefined) return;
	resolved.scope.bindings.set(name, {
		initializer: null,
		canonicalCreateRequire: false,
		canonicalCreateRequireFactory: false,
		invalidatedCreateRequireFactory:
			resolved.binding.canonicalCreateRequireFactory === true ||
			resolved.binding.invalidatedCreateRequireFactory === true,
		canonicalCreateRequireResult: false,
		invalidatedCreateRequireResult:
			resolved.binding.canonicalCreateRequireResult === true ||
			resolved.binding.invalidatedCreateRequireResult === true,
		canonicalAmbientRequire: false,
		ambientRequireLike: false,
		invalidatedAmbientRequire:
			resolved.binding.canonicalAmbientRequire === true ||
			resolved.binding.ambientRequireLike === true ||
			resolved.binding.invalidatedAmbientRequire === true,
		canonicalModuleNamespace: false,
		canonicalWriteFileSync: false,
		canonicalReadFileSync: false,
		canonicalFsNamespace: false,
		canonicalPathHelper: undefined,
		canonicalUrlHelper: undefined,
		canonicalPathNamespace: false,
		canonicalUrlNamespace: false,
	});
}

function invalidateAssignmentTarget(scope: StaticScope, target: ts.Node): void {
	if (ts.isIdentifier(target)) {
		invalidateBinding(scope, target.text);
		return;
	}
	if (
		ts.isParenthesizedExpression(target) ||
		ts.isAsExpression(target) ||
		ts.isTypeAssertionExpression(target) ||
		ts.isNonNullExpression(target)
	) {
		invalidateAssignmentTarget(scope, target.expression);
		return;
	}
	if (ts.isArrayLiteralExpression(target)) {
		for (const element of target.elements) {
			if (!ts.isOmittedExpression(element))
				invalidateAssignmentTarget(scope, ts.isSpreadElement(element) ? element.expression : element);
		}
		return;
	}
	if (ts.isObjectLiteralExpression(target)) {
		for (const property of target.properties) {
			if (ts.isShorthandPropertyAssignment(property)) invalidateAssignmentTarget(scope, property.name);
			else if (ts.isPropertyAssignment(property)) invalidateAssignmentTarget(scope, property.initializer);
			else if (ts.isSpreadAssignment(property)) invalidateAssignmentTarget(scope, property.expression);
		}
		return;
	}
	if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken)
		invalidateAssignmentTarget(scope, target.left);
}

interface AssignmentObjectTarget {
	readonly target: ts.Node;
	readonly defaultInitializer?: ts.Expression;
}

function assignmentObjectTarget(property: ts.ObjectLiteralElementLike): AssignmentObjectTarget | null {
	if (ts.isShorthandPropertyAssignment(property)) {
		return { target: property.name, defaultInitializer: property.objectAssignmentInitializer };
	}
	if (ts.isPropertyAssignment(property)) {
		if (
			ts.isBinaryExpression(property.initializer) &&
			property.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
		)
			return { target: property.initializer.left, defaultInitializer: property.initializer.right };
		return { target: property.initializer };
	}
	if (ts.isSpreadAssignment(property)) return { target: property.expression };
	return null;
}

function assignBindingTarget(scope: StaticScope, target: ts.Node, initializer: ts.Expression | null): void {
	if (ts.isIdentifier(target)) {
		if (initializer === null) {
			invalidateBinding(scope, target.text);
			return;
		}
		const canonicalFactory = isCanonicalCreateRequireFactoryExpression(initializer, scope);
		const canonicalResult = isCanonicalCreateRequireResultExpression(initializer, scope);
		const canonicalAmbient = isCanonicalAmbientRequireExpression(initializer, scope);
		if (!canonicalFactory && !canonicalResult && !canonicalAmbient) {
			invalidateBinding(scope, target.text);
			return;
		}
		const bindingScope = resolveBinding(scope, target.text)?.scope ?? scope;
		bindPattern(
			bindingScope,
			target,
			initializer,
			canonicalFactory,
			false,
			false,
			false,
			canonicalAmbient,
			canonicalAmbient,
			scope,
		);
		return;
	}
	if (
		ts.isParenthesizedExpression(target) ||
		ts.isAsExpression(target) ||
		ts.isTypeAssertionExpression(target) ||
		ts.isNonNullExpression(target)
	) {
		assignBindingTarget(scope, target.expression, initializer);
		return;
	}
	if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
		assignBindingTarget(scope, target.left, target.right);
		return;
	}
	if (ts.isArrayLiteralExpression(target)) {
		const source = initializer === null ? null : unwrapExpression(initializer);
		if (source === null || !ts.isArrayLiteralExpression(source)) {
			invalidateAssignmentTarget(scope, target);
			return;
		}
		if (source.elements.some((element) => ts.isSpreadElement(element))) {
			invalidateAssignmentTarget(scope, target);
			return;
		}
		for (const [index, element] of target.elements.entries()) {
			if (ts.isOmittedExpression(element)) continue;
			const targetNode = ts.isSpreadElement(element) ? element.expression : element;
			const sourceElement = source.elements[index];
			const sourceValue =
				sourceElement === undefined || ts.isOmittedExpression(sourceElement) || ts.isSpreadElement(sourceElement)
					? null
					: sourceElement;
			assignBindingTarget(scope, targetNode, sourceValue);
		}
		return;
	}
	if (ts.isObjectLiteralExpression(target)) {
		const source = initializer === null ? null : unwrapExpression(initializer);
		const sourceObject = source !== null && ts.isObjectLiteralExpression(source) ? source : null;
		for (const property of target.properties) {
			const assignment = assignmentObjectTarget(property);
			if (assignment === null) continue;
			const key =
				ts.isSpreadAssignment(property) || property.name === undefined ? null : propertyNameText(property.name);
			let sourceValue: ts.Expression | null = null;
			if (sourceObject !== null && key !== null) {
				const value = objectLiteralPropertyValue(sourceObject, key);
				sourceValue = value === undefined ? (assignment.defaultInitializer ?? null) : value;
			}
			assignBindingTarget(scope, assignment.target, sourceValue);
		}
	}
}

function isCanonicalCreateRequireResult(scope: StaticScope, name: string, resolving = new Set<string>()): boolean {
	if (resolving.has(name)) return false;
	const resolved = resolveBinding(scope, name);
	if (resolved === undefined || resolved.binding.initializer === null) return false;
	const initializer = resolved.binding.initializer;
	const unwrapped = unwrapExpression(initializer);
	if (ts.isCallExpression(unwrapped) && isCanonicalCreateRequireCall(unwrapped.expression, resolved.scope)) return true;
	if (!ts.isIdentifier(unwrapped)) return false;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return isCanonicalCreateRequireResult(resolved.scope, unwrapped.text, nextResolving);
}

function isRuntimeRequire(expression: ts.Expression, scope: StaticScope): boolean {
	const unwrapped = unwrapExpression(expression);
	if (isCanonicalAmbientRequireExpression(unwrapped, scope)) return true;
	if (!ts.isIdentifier(unwrapped)) return false;
	const requireBinding = resolveBinding(scope, unwrapped.text);
	if (requireBinding === undefined) return unwrapped.text === "require";
	if (requireBinding.binding.invalidatedAmbientRequire === true) return false;
	if (requireBinding.binding.invalidatedCreateRequireResult === true) return false;
	if (requireBinding.binding.canonicalCreateRequireResult === true) return true;
	return isCanonicalCreateRequireResult(requireBinding.scope, unwrapped.text);
}

function isRequireLikeCall(expression: ts.Expression, scope: StaticScope): boolean {
	const unwrapped = unwrapExpression(expression);
	if (isAmbientRequireShape(unwrapped)) return true;
	if (!ts.isIdentifier(unwrapped)) return false;
	if (unwrapped.text === "require") return true;
	const binding = resolveBinding(scope, unwrapped.text)?.binding;
	if (binding?.invalidatedAmbientRequire === true || binding?.ambientRequireLike === true) return true;
	if (binding?.invalidatedCreateRequireResult === true || binding?.canonicalCreateRequireResult === true) return true;
	return isCanonicalCreateRequireResult(scope, unwrapped.text);
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
	readonly projectFiles: ReadonlySet<string>;
	readonly prefix: string;
	readonly suffix: string;
	readonly hasWildcard: boolean;
	readonly baseUrl: string;
	readonly targets: readonly string[];
}

function loadPathAliases(root: string): readonly PathAlias[] {
	const aliases: PathAlias[] = [];
	for (const configPath of walk(root, (path) => /^tsconfig(?:\.[^/]+)?\.json$/.test(basename(path)))) {
		const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
		if (configResult.error !== undefined || configResult.config === undefined) {
			const message =
				configResult.error === undefined
					? "unknown configuration error"
					: ts.flattenDiagnosticMessageText(configResult.error.messageText, "\n");
			throw new Error(`Unable to read TypeScript configuration ${relativePath(root, configPath)}: ${message}`);
		}
		const diagnostics: ts.Diagnostic[] = [];
		const configHost: ts.ParseConfigFileHost = {
			useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
			fileExists: ts.sys.fileExists,
			readDirectory: ts.sys.readDirectory,
			readFile: ts.sys.readFile,
			getCurrentDirectory: () => dirname(configPath),
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		};
		const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, configHost);
		const errors = [...diagnostics, ...(parsed?.errors ?? [])].filter((diagnostic) => diagnostic.code !== 18003);
		if (parsed === undefined || errors.length > 0) {
			const message = errors
				.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
				.join("; ");
			throw new Error(
				`Invalid TypeScript configuration ${relativePath(root, configPath)}: ${message || "unable to parse"}`,
			);
		}
		const compilerOptions = parsed.options;
		const paths = compilerOptions.paths;
		if (paths === undefined) continue;
		const projectFiles = new Set(parsed.fileNames.map((fileName) => resolve(fileName)));
		const baseUrl = compilerOptions.baseUrl ?? dirname(configPath);
		for (const [pattern, value] of Object.entries(paths)) {
			if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
				throw new Error(`Invalid TypeScript path alias in ${relativePath(root, configPath)}: ${pattern}`);
			const wildcard = pattern.indexOf("*");
			aliases.push({
				configDirectory: dirname(configPath),
				projectFiles,
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
	const matching = aliases.filter((alias) => alias.projectFiles.has(path));
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
	const preferredExtension = extension === ".cjs" ? ".cts" : extension === ".mjs" ? ".mts" : null;
	const extensionCandidates = [
		...(preferredExtension === null ? [] : [`${sourceBase}${preferredExtension}`]),
		...RESOLUTION_EXTENSIONS.map((item) => `${sourceBase}${item}`),
	];
	const candidates = [
		base,
		...(preferredExtension === null ? [] : [`${sourceBase}${preferredExtension}`]),
		sourceBase,
		...extensionCandidates,
		...RESOLUTION_EXTENSIONS.map((item) => join(sourceBase, `index${item}`)),
	];
	for (const candidate of new Set(candidates)) if (files.has(candidate)) return candidate;
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
	let count = 0;
	for (const comment of actualCommentTrivia(source)) {
		for (const line of comment.split("\n")) {
			const content = line
				.trim()
				.replace(/^\/\*+\s?/, "")
				.replace(/^\/\/\s?/, "")
				.replace(/^#\s?/, "")
				.replace(/^\*\s?/, "")
				.replace(/\s?\*\/$/, "")
				.trim();
			if (/^@ts-(?:ignore|expect-error)(?:\s|$)/.test(content)) count++;
		}
	}
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
	const protectedGeneratedArtifactManifest =
		options.validateGeneratedArtifacts === false ? loadProtectedGeneratedArtifactManifest(root) : undefined;
	const generatedArtifactManifest =
		options.validateGeneratedArtifacts === false ? [] : loadGeneratedArtifactManifest(root);
	const pathAliases = loadPathAliases(root);
	const manifestedByPath = new Map(generatedArtifactManifest.map((artifact) => [artifact.path, artifact]));
	const candidates = walk(
		sourceRoot,
		(path) =>
			SOURCE_EXTENSIONS.includes(extname(path) as (typeof SOURCE_EXTENSIONS)[number]) &&
			!path.endsWith(".d.ts") &&
			!path.endsWith(".d.tsx") &&
			!path.endsWith(".d.cts") &&
			!path.endsWith(".d.mts"),
	);
	const materializedManifestPaths = new Set<string>();
	const generatedArtifacts = candidates
		.filter((path) => !EXCLUDED_PATH_PARTS.some((part) => normalizedPath(path).includes(part)))
		.flatMap((path) => {
			const source = readFileSync(path, "utf8");
			const relative = relativePath(root, path);
			const manifested = manifestedByPath.get(relative);
			if (manifested !== undefined) materializedManifestPaths.add(relative);
			const unmanifestedReason =
				options.validateGeneratedArtifacts === false ? null : unmanifestedGeneratedReason(path, source);
			if (manifested === undefined && unmanifestedReason !== null)
				throw new Error(
					`Generated artifact ${relative} matches ${unmanifestedReason} but is not listed in scripts/architecture-generated-artifacts.json`,
				);
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
				for (const parameter of node.parameters)
					bindPattern(currentScope, parameter.name, parameter.initializer ?? null);
				predeclareVarBindings(node, currentScope);
				predeclareFunctionBindings(node, currentScope);
			} else if (
				ts.isSourceFile(node) ||
				ts.isBlock(node) ||
				ts.isModuleDeclaration(node) ||
				ts.isModuleBlock(node) ||
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
				if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node))
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
				bindPattern(bindingScope, node.name, node.initializer ?? null);
			}
			if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.getText(sourceFile))) {
				if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
					assignBindingTarget(currentScope, node.left, node.right);
				else invalidateAssignmentTarget(currentScope, node.left);
			}
			if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
				assignBindingTarget(currentScope, node.initializer, null);
			if (
				ts.isPrefixUnaryExpression(node) &&
				(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
				ts.isIdentifier(node.operand)
			)
				invalidateBinding(currentScope, node.operand.text);
			if (
				ts.isPostfixUnaryExpression(node) &&
				ts.isIdentifier(node.operand) &&
				(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
			)
				invalidateBinding(currentScope, node.operand.text);
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
						: isRequireLikeCall(expression, currentScope)
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
		...(protectedGeneratedArtifactManifest === undefined ? {} : { protectedGeneratedArtifactManifest }),
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

	const protectedGeneratedArtifacts = baseline.protectedGeneratedArtifactManifest ?? baseline.generatedArtifactManifest;
	for (const artifact of current.generatedArtifactManifest) {
		const protectedArtifact = protectedGeneratedArtifacts.find((candidate) => candidate.path === artifact.path);
		if (protectedArtifact === undefined) {
			findings.push(`generated artifact manifest entry ${artifact.path} is not present in protected history`);
			continue;
		}
		if (
			protectedArtifact.owner !== artifact.owner ||
			protectedArtifact.source !== artifact.source ||
			protectedArtifact.generatedBy !== artifact.generatedBy
		) {
			findings.push(
				`generated artifact manifest entry ${artifact.path} does not match protected ownership/dataflow (${artifact.owner}, ${artifact.source}, ${artifact.generatedBy})`,
			);
		}
	}

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
		// The auditor is the implementation of this contract. Its own growth is
		// reviewed as tooling, not treated as product architecture debt.
		if (module.path === "scripts/audit-architecture-contract.ts") continue;
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
	const baselinePathArgument = process.argv.find((argument) => argument.startsWith("--baseline-path="));
	const baselinePath = baselinePathArgument?.slice("--baseline-path=".length) ?? BASELINE_PATH;
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
	const findings = compareArchitectureRatchet(inventory, loadBaseline(baselinePath));
	if (findings.length > 0) {
		console.error("Architecture ratchet violations:");
		for (const finding of findings) console.error(`- ${finding}`);
		process.exitCode = 1;
	} else {
		console.log("Architecture ratchet: baseline respected");
	}
}

if (import.meta.main) main();
