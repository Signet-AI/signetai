import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";

function canonical(path: string): string {
	const absolute = resolve(path.trim().replace(/^~(?=$|\/|\\)/, homedir()));
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function privatePaths(agentsDir: string): readonly string[] {
	const layout = resolveWorkspaceLayout(agentsDir);
	return [layout.runtime, join(layout.root, ".daemon"), layout.secrets, dirname(layout.database)].map(canonical);
}

function isWithin(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isHiddenBelow(path: string, root: string): boolean {
	return relative(root, path)
		.split(sep)
		.some((part) => part.startsWith("."));
}

export function isWorkspacePrivatePath(path: string, agentsDir: string): boolean {
	const target = canonical(path);
	return privatePaths(agentsDir).some((entry) => isWithin(target, entry));
}

export function exposesWorkspacePrivatePath(root: string, agentsDir: string): boolean {
	const target = canonical(root);
	return privatePaths(agentsDir).some(
		(entry) => isWithin(target, entry) || (isWithin(entry, target) && !isHiddenBelow(entry, target)),
	);
}
