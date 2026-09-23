import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

export type GitMetadataCapture = { source: string; directory: string; repositories: string[] };

function copyNode(source: string, target: string): void {
	const stat = lstatSync(source);
	mkdirSync(dirname(target), { recursive: true });
	if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
	else if (stat.isDirectory()) {
		mkdirSync(target, { recursive: true, mode: stat.mode & 0o7777 });
		for (const name of readdirSync(source)) copyNode(join(source, name), join(target, name));
	} else {
		writeFileSync(target, readFileSync(source), { mode: stat.mode & 0o7777 });
		chmodSync(target, stat.mode & 0o7777);
	}
}

function findRepositories(root: string): string[] {
	const result = [""];
	const walk = (dir: string, rel: string) => {
		for (const name of readdirSync(dir)) {
			if (name === ".git") continue;
			const path = join(dir, name);
			if (!lstatSync(path).isDirectory()) continue;
			const child = join(path, ".git");
			if (existsSync(child)) result.push(join(rel, name));
			else walk(path, join(rel, name));
		}
	};
	walk(root, "");
	return result;
}

/** Read-only Git preservation: captures only Git metadata, never the worktree or source. */
export function captureGitMetadata(source: string, directory: string): GitMetadataCapture {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const repositories = findRepositories(source);
	for (const rel of repositories) copyNode(join(source, rel, ".git"), join(directory, rel, ".git"));
	writeFileSync(join(directory, "manifest.json"), `${JSON.stringify({ source, repositories })}\n`, { mode: 0o600 });
	return { source, directory, repositories };
}

/** Restore captured root and nested repository metadata without touching source. */
export function restoreGitMetadata(capture: GitMetadataCapture, destination: string): void {
	for (const rel of capture.repositories) {
		const source = join(capture.directory, rel, ".git");
		const target = join(destination, rel, ".git");
		if (existsSync(target))
			throw new Error(`destination Git metadata already exists: ${relative(destination, target)}`);
		copyNode(source, target);
	}
}
