import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ShippedPackage {
	readonly name: string;
	readonly version: string;
}

export const shippedArtifacts = ["daemon", "daemon-js-vendor", "dashboard", "native", "signet-mcp"] as const;
export type ShippedArtifact = (typeof shippedArtifacts)[number];

export const shippedPackagesDir = fileURLToPath(new URL("../dist/shipped-packages/", import.meta.url));

const marker = "/node_modules/";
export const workspaceBundleInputsDir = ".bundle-inputs";
const embeddedBundleSuffix = "-bundle.ts";

export function packageRoot(file: string): string | null {
	const path = file.replaceAll("\\", "/");
	const index = path.lastIndexOf(marker);
	if (index === -1) return null;
	const segments = path.slice(index + marker.length).split("/");
	const depth = segments[0]?.startsWith("@") ? 2 : 1;
	if (segments.length < depth || segments.slice(0, depth).some((segment) => segment === "")) return null;
	return `${path.slice(0, index)}${marker}${segments.slice(0, depth).join("/")}`;
}

export function readPackage(dir: string): ShippedPackage {
	const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	if (typeof manifest !== "object" || manifest === null) throw new Error(`Invalid package manifest in ${dir}`);
	const name = "name" in manifest ? manifest.name : undefined;
	const version = "version" in manifest ? manifest.version : undefined;
	if (typeof name !== "string" || typeof version !== "string") {
		throw new Error(`Package manifest in ${dir} has no name and version`);
	}
	return { name, version };
}

function objectField(value: unknown, key: string): object | null {
	if (typeof value !== "object" || value === null || !(key in value)) return null;
	const field: unknown = Reflect.get(value, key);
	return typeof field === "object" && field !== null ? field : null;
}

function workspaceOf(file: string): string | null {
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
			if (typeof parsed === "object" && parsed !== null && "name" in parsed) return dir;
		}
		if (dirname(dir) === dir) return null;
	}
}

function workspaceBundles(workspace: string): Map<string, readonly string[]> {
	const bundles = new Map<string, readonly string[]>();
	const recordedBy = new Map<string, string>();
	const dir = join(workspace, workspaceBundleInputsDir);
	if (!existsSync(dir)) return bundles;
	for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
		const path = join(dir, name);
		const outputs = objectField(JSON.parse(readFileSync(path, "utf8")), "outputs");
		if (outputs === null) throw new Error(`${path} has no outputs`);
		for (const [output, info] of Object.entries(outputs)) {
			const inputs = Object.keys(objectField(info, "inputs") ?? {});
			const file = resolve(workspace, "dist", output);
			const previous = recordedBy.get(file);
			if (previous !== undefined) throw new Error(`${file} is recorded by both ${previous} and ${path}`);
			recordedBy.set(file, path);
			bundles.set(
				file,
				inputs.map((input) => resolve(workspace, input)),
			);
		}
	}
	return bundles;
}

export function packagesFromFiles(files: Iterable<string>, cwd: string): ShippedPackage[] {
	const roots = new Set<string>();
	const seen = new Set<string>();
	const bundles = new Map<string, Map<string, readonly string[]>>();
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		const root = packageRoot(file);
		if (root !== null) {
			roots.add(root);
			return;
		}
		const workspace = workspaceOf(file);
		if (workspace === null) return;
		const outputs = bundles.get(workspace) ?? workspaceBundles(workspace);
		bundles.set(workspace, outputs);
		const inputs = outputs.get(file);
		if (inputs !== undefined) {
			for (const input of inputs) visit(input);
			return;
		}
		const inDist = relative(join(workspace, "dist"), file);
		if ((!inDist.startsWith("..") && !isAbsolute(inDist)) || file.endsWith(embeddedBundleSuffix)) {
			throw new Error(
				`${file} is a prebuilt bundle with no recorded inputs; build it with --metafile=${workspaceBundleInputsDir}/<name>.json or write it with recordEmbeddedBundle`,
			);
		}
	};
	for (const file of files) {
		if (file.startsWith("\0")) continue;
		visit(resolve(cwd, file.split("?")[0] ?? file));
	}
	return [...roots].map(readPackage);
}

export function recordEmbeddedBundle(workspace: string, generated: string, embedded: readonly string[]): void {
	if (!generated.endsWith(embeddedBundleSuffix))
		throw new Error(`Embedded bundle ${generated} must end in ${embeddedBundleSuffix}`);
	const dir = join(workspace, workspaceBundleInputsDir);
	mkdirSync(dir, { recursive: true });
	const inputs = Object.fromEntries(embedded.map((file) => [relative(workspace, file), {}]));
	const outputs = { [relative(join(workspace, "dist"), generated)]: { inputs } };
	writeFileSync(join(dir, "embedded.json"), `${JSON.stringify({ outputs }, null, "\t")}\n`);
}

export function packagesFromMetafile(metafile: unknown, cwd: string): ShippedPackage[] {
	const parsed: unknown = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
	if (typeof parsed !== "object" || parsed === null || !("inputs" in parsed)) {
		throw new Error("Build metafile has no inputs");
	}
	const inputs = parsed.inputs;
	if (typeof inputs !== "object" || inputs === null) throw new Error("Build metafile inputs are not an object");
	return packagesFromFiles(Object.keys(inputs), cwd);
}

export function packagesInlinedBy(source: string): ShippedPackage[] {
	const store = /node_modules\/\.(?:pnpm|bun)\/((?:@[^/+@]+\+)?[^/+@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[^/]*\//g;
	return uniquePackages(
		[...source.matchAll(store)].map((match) => ({
			name: (match[1] ?? "").replace("+", "/"),
			version: match[2] ?? "",
		})),
	);
}

export function packagesInTree(dir: string): ShippedPackage[] {
	const found: ShippedPackage[] = [];
	const visit = (modules: string): void => {
		if (!existsSync(modules)) return;
		for (const name of readdirSync(modules)) {
			if (name.startsWith(".")) continue;
			const path = join(modules, name);
			if (!statSync(path).isDirectory()) continue;
			if (name.startsWith("@")) {
				for (const scoped of readdirSync(path)) visitPackage(join(path, scoped));
				continue;
			}
			visitPackage(path);
		}
	};
	const visitPackage = (path: string): void => {
		if (!existsSync(join(path, "package.json"))) return;
		found.push(readPackage(path));
		visit(join(path, "node_modules"));
	};
	visit(join(dir, "node_modules"));
	return found;
}

export function uniquePackages(packages: Iterable<ShippedPackage>): ShippedPackage[] {
	const byKey = new Map<string, ShippedPackage>();
	for (const item of packages) byKey.set(`${item.name}@${item.version}`, { name: item.name, version: item.version });
	return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
}

export function recordShippedPackages(
	artifact: ShippedArtifact,
	packages: Iterable<ShippedPackage>,
	dir = shippedPackagesDir,
): void {
	const list = uniquePackages(packages);
	if (list.length === 0) throw new Error(`No third-party packages were recorded for ${artifact}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${artifact}.json`), `${JSON.stringify(list, null, "\t")}\n`);
}
