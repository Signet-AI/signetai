import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ShippedPackage {
	readonly name: string;
	readonly version: string;
}

export const shippedArtifacts = ["daemon", "daemon-js-vendor", "dashboard", "native", "signet-mcp"] as const;
export type ShippedArtifact = (typeof shippedArtifacts)[number];

export const shippedPackagesDir = fileURLToPath(new URL("../dist/shipped-packages/", import.meta.url));

const marker = "/node_modules/";

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

export function packagesFromFiles(files: Iterable<string>, cwd: string): ShippedPackage[] {
	const roots = new Set<string>();
	for (const file of files) {
		if (file.startsWith("\0")) continue;
		const root = packageRoot(resolve(cwd, file.split("?")[0] ?? file));
		if (root !== null) roots.add(root);
	}
	return [...roots].map(readPackage);
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
