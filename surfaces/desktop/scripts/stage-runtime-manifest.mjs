import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function contained(root, path) {
	if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
		throw new Error(`Invalid runtime manifest path: ${path}`);
	const target = resolve(root, path);
	const rel = relative(root, target);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error(`Invalid runtime manifest path: ${path}`);
	return target;
}

export function copyManifest(sourceRoot, stagedRoot, manifestFile) {
	const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	if (
		manifest.version !== 1 ||
		!Array.isArray(manifest.files) ||
		manifest.platform !== process.platform ||
		manifest.arch !== process.arch
	)
		throw new Error("Invalid or incompatible runtime manifest");
	const seen = new Set();
	for (const item of manifest.files) {
		const source = contained(sourceRoot, item.source);
		const destination = contained(stagedRoot, item.path);
		if (seen.has(item.path)) throw new Error(`Duplicate runtime manifest path: ${item.path}`);
		seen.add(item.path);
		if (!statSync(source, { throwIfNoEntry: false })?.isFile())
			throw new Error(`Missing runtime asset ${item.path}: ${source}`);
		const bytes = readFileSync(source);
		if (bytes.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
			throw new Error(`Runtime manifest integrity mismatch: ${item.path}`);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(source, destination, { dereference: true });
		chmodSync(destination, item.mode);
	}
	return manifest.files.length;
}
