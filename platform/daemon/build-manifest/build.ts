import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import {
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { BunPlugin } from "bun";

interface Asset {
	readonly source: string;
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
	readonly mode: number;
}

interface Graph {
	readonly inputs: Record<
		string,
		{ readonly imports: readonly { readonly path: string; readonly external?: boolean }[] }
	>;
}

function files(root: string, excluded: string | null): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (path === excluded || entry.name === ".git") return [];
		if (entry.isSymbolicLink() && statSync(path).isDirectory())
			throw new Error(`Runtime asset directory symlink must have an explicit producer: ${path}`);
		return entry.isDirectory() ? files(path, excluded) : statSync(path).isFile() ? [path] : [];
	});
}

function packageName(specifier: string): string | null {
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("#") ||
		isAbsolute(specifier) ||
		specifier.startsWith("bun:") ||
		builtinModules.includes(specifier) ||
		specifier.startsWith("node:")
	)
		return null;
	return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? null);
}

function packageRoot(name: string, importer: string): string {
	const require = createRequire(importer);
	let entry: string;
	try {
		entry = require.resolve(`${name}/package.json`);
	} catch {
		try {
			entry = require.resolve(name);
		} catch {
			for (const directory of require.resolve.paths(name) ?? []) {
				const root = join(directory, name);
				const manifest = join(root, "package.json");
				if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return realpathSync(root);
			}
			throw new Error(`Missing runtime dependency ${name} imported by ${importer}`);
		}
	}
	if (!existsSync(entry)) throw new Error(`Missing runtime dependency ${name} imported by ${importer}`);
	let root = dirname(entry);
	for (let depth = 0; depth < 20; depth++) {
		const manifest = join(root, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return root;
		const parent = dirname(root);
		if (parent === root) break;
		root = parent;
	}
	throw new Error(`Invalid runtime dependency metadata ${name} imported by ${importer}`);
}

export function runtimeReferences(path: string): readonly string[] {
	const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const references = new Set<string>();
	const resolvers = new Set(["resolveRuntimeAsset"]);
	const workers = new Set(["Worker"]);
	function aliases(node: ts.Node): void {
		if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === "resolveRuntimeAsset")
			resolvers.add(node.name.text);
		if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === "Worker")
			workers.add(node.name.text);
		ts.forEachChild(node, aliases);
	}
	aliases(ast);
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			((ts.isIdentifier(node.expression) && resolvers.has(node.expression.text)) ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolveRuntimeAsset"))
		) {
			const name = node.arguments[0];
			if (name && ts.isStringLiteralLike(name)) references.add(name.text.replace(/^\.\//, ""));
		}
		if (
			ts.isNewExpression(node) &&
			((ts.isIdentifier(node.expression) && workers.has(node.expression.text)) ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "Worker"))
		) {
			const arg = node.arguments?.[0];
			if (arg && ts.isStringLiteralLike(arg)) {
				if (/\.tsx?$/.test(arg.text)) throw new Error(`Worker asset must be built: ${arg.text}`);
				references.add(arg.text.replace(/^\.\//, ""));
			}
			if (arg && ts.isNewExpression(arg) && arg.expression.getText(ast) === "URL") {
				const name = arg.arguments?.[0];
				if (!name || !ts.isStringLiteralLike(name)) throw new Error(`Unresolved Worker asset in ${path}`);
				if (/\.tsx?$/.test(name.text)) throw new Error(`Worker asset must be built: ${name.text}`);
				references.add(name.text.replace(/^\.\//, ""));
			}
		}
		if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL") {
			const name = node.arguments?.[0];
			if (
				name &&
				ts.isStringLiteralLike(name) &&
				/\.(?:[cm]?js|node|wasm)$/.test(name.text) &&
				node.arguments?.[1]?.getText(ast) === "import.meta.url"
			)
				references.add(name.text.replace(/^\.\//, ""));
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	for (const name of references)
		if (isAbsolute(name) || name.split(/[\\/]/).includes(".."))
			throw new Error(`Runtime asset must be package-relative: ${name}`);
	return [...references];
}

export function runtimePackages(path: string, bun = false): readonly string[] {
	const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const bunFlags = new Set<string>();
	function findFlags(node: ts.Node): void {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isBinaryExpression(node.initializer) &&
			node.initializer.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
			ts.isTypeOfExpression(node.initializer.left) &&
			ts.isStringLiteral(node.initializer.right) &&
			node.initializer.right.text === "undefined"
		) {
			const value = node.initializer.left.expression;
			if (
				(ts.isPropertyAccessExpression(value) && value.name.text === "Bun") ||
				(ts.isIdentifier(value) && value.text === "Bun")
			)
				bunFlags.add(node.name.text);
		}
		ts.forEachChild(node, findFlags);
	}
	findFlags(ast);
	function inactive(node: ts.Node): boolean {
		if (!bun) return false;
		let parent: ts.Node | undefined = node.parent;
		while (parent) {
			if (
				ts.isIfStatement(parent) &&
				ts.isIdentifier(parent.expression) &&
				bunFlags.has(parent.expression.text) &&
				parent.elseStatement &&
				node.pos >= parent.elseStatement.pos &&
				node.end <= parent.elseStatement.end
			)
				return true;
			parent = parent.parent;
		}
		return false;
	}
	const names = new Set<string>();
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
			const arg = node.arguments[0];
			if (arg && ts.isStringLiteralLike(arg)) {
				const name = packageName(arg.text);
				if (name && !inactive(node)) names.add(name);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	return [...names];
}

function guardedPackage(path: string, name: string): boolean {
	const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	let guarded = false;
	function visit(node: ts.Node): void {
		if (ts.isStringLiteralLike(node) && packageName(node.text) === name && ts.isCallExpression(node.parent)) {
			let parent: ts.Node | undefined = node.parent;
			while (parent) {
				if (
					ts.isTryStatement(parent) &&
					node.pos >= parent.tryBlock.pos &&
					node.end <= parent.tryBlock.end &&
					parent.catchClause
				)
					guarded = true;
				parent = parent.parent;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	return guarded;
}

export class RuntimeManifest {
	readonly #root: string;
	readonly #assets = new Map<string, Asset>();
	readonly #packages = new Map<string, string>();
	readonly #optionalAbsent = new Set<string>();

	constructor(root: string) {
		this.#root = realpathSync(root);
	}

	add(source: string, path: string): void {
		const info = statSync(source, { throwIfNoEntry: false });
		if (!info?.isFile()) throw new Error(`Missing runtime asset ${path}: ${source}`);
		const origin = realpathSync(source);
		const input = relative(this.#root, origin).split(sep).join("/");
		if (input.startsWith("../") || path.split("/").includes(".."))
			throw new Error(`Runtime asset escapes build root: ${source}`);
		const data = readFileSync(origin);
		const asset = {
			source: input,
			path,
			size: data.length,
			sha256: createHash("sha256").update(data).digest("hex"),
			mode: info.mode & 0o777,
		};
		const previous = this.#assets.get(path);
		if (previous && previous.sha256 !== asset.sha256) throw new Error(`Conflicting runtime asset ${path}`);
		this.#assets.set(path, asset);
	}

	tree(source: string, destination: string): void {
		if (!statSync(source, { throwIfNoEntry: false })?.isDirectory())
			throw new Error(`Missing runtime asset directory ${destination}: ${source}`);
		for (const file of files(source, null))
			this.add(file, `${destination}/${relative(source, file).split(sep).join("/")}`);
	}

	dependency(
		name: string,
		importer: string,
		optional = false,
		destination = `node_modules/${name}`,
		scopes: readonly string[] = [],
	): void {
		let root: string;
		try {
			root = packageRoot(name, importer);
		} catch (error) {
			if (optional && error instanceof Error && error.message.startsWith("Missing runtime dependency ")) {
				this.#optionalAbsent.add(name);
				return;
			}
			throw error;
		}
		root = realpathSync(root);
		const origin = relative(this.#root, root);
		if (origin.startsWith(`..${sep}`) || isAbsolute(origin)) {
			if (optional) {
				this.#optionalAbsent.add(name);
				return;
			}
			throw new Error(`Runtime dependency ${name} imported by ${importer} resolved outside the build root: ${root}`);
		}
		const visible = scopes.length ? scopes : [destination.slice(0, -name.length)];
		let conflicting = false;
		for (const scope of visible) {
			const existing = this.#packages.get(`${scope}${name}`);
			if (existing === root) return;
			if (existing) {
				conflicting = true;
				break;
			}
		}
		if (scopes.length) destination = `${conflicting ? visible[0] : visible[visible.length - 1]}${name}`;
		const previous = this.#packages.get(destination);
		if (previous)
			throw new Error(`Conflicting runtime dependency versions: ${name}: ${previous} / ${root}, importer ${importer}`);
		this.#packages.set(destination, root);
		for (const file of files(root, join(root, "node_modules")))
			this.add(file, `${destination}/${relative(root, file).split(sep).join("/")}`);
		const ancestry = [`${destination}/node_modules/`, ...visible];
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const bundled = pkg.bundledDependencies ?? pkg.bundleDependencies;
		if (Array.isArray(bundled))
			for (const dependency of bundled)
				this.dependency(
					dependency,
					join(root, "package.json"),
					false,
					`${destination}/node_modules/${dependency}`,
					ancestry,
				);
		for (const dependency of Object.keys(pkg.dependencies ?? {}))
			this.dependency(
				dependency,
				join(root, "package.json"),
				false,
				`${destination}/node_modules/${dependency}`,
				ancestry,
			);
		for (const dependency of Object.keys(pkg.peerDependencies ?? {}))
			this.dependency(
				dependency,
				join(root, "package.json"),
				pkg.peerDependenciesMeta?.[dependency]?.optional === true,
				`${destination}/node_modules/${dependency}`,
				ancestry,
			);
		for (const dependency of Object.keys(pkg.optionalDependencies ?? {}))
			this.dependency(
				dependency,
				join(root, "package.json"),
				true,
				`${destination}/node_modules/${dependency}`,
				ancestry,
			);
	}

	plugin(options: {
		readonly output: string;
		readonly directory: string;
		readonly aliases: Readonly<Record<string, string>>;
		readonly external: readonly string[];
	}): BunPlugin {
		return {
			name: "runtime-dependency-closure",
			setup: (build) => {
				build.onResolve({ filter: /^[^./]/ }, (input) => {
					if (!input.importer || Object.hasOwn(options.aliases, input.path)) return undefined;
					const name = packageName(input.path);
					if (!name) return undefined;
					const allowAbsent =
						options.external.some((external) => input.path === external || input.path.startsWith(`${external}/`)) ||
						guardedPackage(input.importer, name);
					const path = this.external(input.path, input.importer, allowAbsent);
					if (path === input.path) return { path, external: true };
					return path
						? {
								path: `./${relative(dirname(options.output), resolve(options.directory, path)).split(sep).join("/")}`,
								external: true,
							}
						: undefined;
				});
			},
		};
	}

	external(specifier: string, importer: string, allowAbsent = false): string | null {
		const name = packageName(specifier);
		if (!name) return null;
		let root: string;
		try {
			root = packageRoot(name, importer);
		} catch (error) {
			if (allowAbsent && error instanceof Error && error.message.startsWith("Missing runtime dependency "))
				return specifier;
			throw error;
		}
		if (!root.includes(`${sep}node_modules${sep}`)) return null;
		const origin = relative(this.#root, root);
		if (allowAbsent && (origin.startsWith(`..${sep}`) || isAbsolute(origin))) return specifier;
		const entry = Bun.resolveSync(specifier, dirname(importer));
		const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
		const identity = createHash("sha256").update(relative(this.#root, root)).digest("hex").slice(0, 12);
		const directory = `dist/vendor/${name.replace(/[^a-zA-Z0-9_-]/g, "_")}@${version}-${identity}/node_modules/${name}`;
		this.dependency(name, importer, false, directory);
		const subpath = relative(root, entry).split(sep).join("/");
		if (subpath.startsWith("../")) throw new Error(`Runtime dependency entry escapes its package: ${specifier}`);
		return `./${directory.slice("dist/".length)}/${subpath}`;
	}

	graph(graph: Graph, cwd: string): readonly string[] {
		const workers = new Set<string>();
		for (const [input, meta] of Object.entries(graph.inputs)) {
			const path = resolve(cwd, input);
			const names = new Set(
				meta.imports.flatMap((item) => {
					const name = item.external ? packageName(item.path) : null;
					return name ? [name] : [];
				}),
			);
			if (statSync(path, { throwIfNoEntry: false })?.isFile() && /\.[cm]?[jt]sx?$/.test(path)) {
				for (const worker of runtimeReferences(path)) workers.add(worker);
				if (!path.includes(`${sep}node_modules${sep}`)) for (const name of runtimePackages(path, true)) names.add(name);
			}
			for (const name of names) {
				let directory = dirname(path);
				while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory)
					directory = dirname(directory);
				const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
				this.dependency(
					name,
					path,
					pkg.peerDependenciesMeta?.[name]?.optional === true ||
						name in (pkg.optionalDependencies ?? {}) ||
						(!(name in (pkg.dependencies ?? {})) && guardedPackage(path, name)),
				);
			}
		}
		return [...workers];
	}

	require(path: string): void {
		if (!this.#assets.has(path)) throw new Error(`Unaccounted runtime asset: ${path}`);
	}

	materialize(directory: string): void {
		for (const asset of this.#assets.values()) {
			if (!asset.path.startsWith("dist/")) continue;
			const source = join(this.#root, asset.source);
			const target = join(directory, asset.path);
			if (source === target) continue;
			mkdirSync(dirname(target), { recursive: true });
			rmSync(target, { force: true });
			try {
				linkSync(source, target);
			} catch {
				copyFileSync(source, target);
			}
		}
	}

	write(path: string): void {
		writeFileSync(
			path,
			`${JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, optionalAbsent: [...this.#optionalAbsent].sort(), files: [...this.#assets.values()].sort((a, b) => a.path.localeCompare(b.path)) }, null, "\t")}\n`,
		);
	}
}
