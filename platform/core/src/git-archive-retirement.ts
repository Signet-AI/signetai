import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	copyFileSync,
	chmodSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { inspectRootGit, type RootGitInventory } from "./git-transition";

export interface RootGitArchive {
	root: string;
	directory: string;
	bundlePath: string;
	liveArchivePath: string;
	manifestPath: string;
	verificationPath: string;
}
export interface RootGitArchiveVerification {
	verified: boolean;
	reason?: string;
}
export interface RootGitArchivePlan {
	readonly inventory: RootGitInventory;
	readonly archive: RootGitArchive;
	readonly redactedPaths: readonly string[];
}

function runGit(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error((result.stderr || "git command failed").trim());
	return result.stdout.trim();
}
function digest(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}
function copyTree(source: string, target: string): void {
	const info = lstatSync(source);
	mkdirSync(dirname(target), { recursive: true });
	if (info.isSymbolicLink()) {
		symlinkSync(readlinkSync(source), target);
	} else if (info.isDirectory()) {
		mkdirSync(target, { recursive: true });
		for (const entry of readdirSync(source)) copyTree(join(source, entry), join(target, entry));
	} else {
		copyFileSync(source, target);
		chmodSync(target, info.mode & 0o7777);
	}
}
function nestedRepositories(root: string): string[] {
	const found: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === ".git" || entry.name === ".signet-root-git-retirement") continue;
			const path = join(dir, entry.name);
			if (existsSync(join(path, ".git"))) found.push(relative(root, path));
			else visit(path);
		}
	};
	visit(root);
	return found;
}
function gitDir(root: string): string {
	return resolve(root, runGit(root, ["rev-parse", "--git-dir"]));
}

function trackedAndUntracked(root: string, archiveDir: string): string[] {
	const output = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(3))
		.filter((p) => !p.startsWith(relative(root, archiveDir)));
}

/** Build an archive plan only; it performs no Git mutation. */
export function planRootGitArchive(root: string, directory: string): RootGitArchivePlan {
	const resolvedRoot = resolve(root);
	const inventory = inspectRootGit(resolvedRoot);
	if (!inventory.isRootRepository) throw new Error("refusing archive: target is not the repository root");
	if (runGit(resolvedRoot, ["rev-parse", "--is-bare-repository"]) === "true")
		throw new Error("refusing archive: bare repository");
	const nested = nestedRepositories(resolvedRoot);
	if (nested.length) throw new Error(`refusing archive: nested repositories detected (${nested.join(", ")})`);
	const archive = makeArchivePaths(resolvedRoot, directory);
	return { inventory, archive, redactedPaths: [".git/objects", ".git/logs", ".git/credentials"] };
}
function makeArchivePaths(root: string, directory: string): RootGitArchive {
	const dir = resolve(directory);
	return {
		root,
		directory: dir,
		bundlePath: join(dir, "repository.bundle"),
		liveArchivePath: join(dir, "live-state.tar"),
		manifestPath: join(dir, "manifest.json"),
		verificationPath: join(dir, "VERIFIED"),
	};
}

export function prepareRootGitArchive(root: string, directory: string): RootGitArchive {
	const plan = planRootGitArchive(root, directory);
	const { archive } = plan;
	mkdirSync(archive.directory, { recursive: true });
	rmSync(archive.verificationPath, { force: true });
	runGit(root, ["bundle", "create", archive.bundlePath, "--all"]);
	const stage = join(tmpdir(), `signet-retirement-${process.pid}-${Date.now()}`);
	mkdirSync(stage, { recursive: true });
	try {
		const worktree = join(stage, "worktree");
		mkdirSync(worktree, { recursive: true });
		// Copy the complete checkout, including ignored and untracked state, but never the output.
		for (const entry of readdirSync(root))
			if (entry !== ".git" && resolve(join(root, entry)) !== archive.directory)
				copyTree(join(root, entry), join(worktree, entry));
		const gitState = join(stage, "git");
		copyTree(gitDir(root), gitState);
		const tar = spawnSync("tar", ["-cf", archive.liveArchivePath, "-C", stage, "worktree", "git"], {
			encoding: "utf8",
		});
		if (tar.status !== 0) throw new Error(tar.stderr || "live archive failed");
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	const manifest = {
		version: 2,
		repository: digest(root),
		head: runGit(root, ["rev-parse", "HEAD"]),
		refs: digest(runGit(root, ["show-ref", "--head"])),
		redactedPaths: plan.redactedPaths,
		status: trackedAndUntracked(root, archive.directory),
		bundle: digest(readFileSync(archive.bundlePath)),
		liveArchive: digest(readFileSync(archive.liveArchivePath)),
	};
	writeFileSync(archive.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	// Keep the archive artifact outside the repository's tracked working set.
	const excludePath = join(gitDir(root), "info", "exclude");
	mkdirSync(dirname(excludePath), { recursive: true });
	const exclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	const marker = `\n# Signet root Git retirement archive\n${relative(root, archive.directory)}/\n`;
	if (!exclude.includes("# Signet root Git retirement archive"))
		writeFileSync(excludePath, exclude.replace(/\n?$/, "") + marker);
	return archive;
}

export function verifyRootGitArchive(archive: RootGitArchive): RootGitArchiveVerification {
	try {
		const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf8"));
		if (!existsSync(archive.bundlePath) || !existsSync(archive.liveArchivePath))
			return { verified: false, reason: "archive members missing" };
		const check = spawnSync("git", ["bundle", "verify", archive.bundlePath], { encoding: "utf8" });
		if (check.status !== 0) return { verified: false, reason: "bundle verification failed" };
		if (
			digest(readFileSync(archive.bundlePath)) !== manifest.bundle ||
			digest(readFileSync(archive.liveArchivePath)) !== manifest.liveArchive
		)
			return { verified: false, reason: "archive checksum mismatch" };
		if (digest(archive.root) !== manifest.repository)
			return { verified: false, reason: "repository identity mismatch" };
		if (runGit(archive.root, ["rev-parse", "HEAD"]) !== manifest.head)
			return { verified: false, reason: "repository head mismatch" };
		if (digest(runGit(archive.root, ["show-ref", "--head"])) !== manifest.refs)
			return { verified: false, reason: "repository refs mismatch" };
		if (JSON.stringify(trackedAndUntracked(archive.root, archive.directory)) !== JSON.stringify(manifest.status))
			return { verified: false, reason: "repository status mismatch" };
		writeFileSync(archive.verificationPath, `${new Date().toISOString()}\n`);
		return { verified: true };
	} catch (error) {
		return { verified: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export function restoreVerifiedRootGitArchive(archive: RootGitArchive, destination: string): void {
	if (!verifyRootGitArchive(archive).verified) throw new Error("archive must be verified before restore");
	const target = resolve(destination);
	mkdirSync(target, { recursive: true });
	const stage = join(tmpdir(), `signet-retirement-restore-${process.pid}-${Date.now()}`);
	mkdirSync(stage, { recursive: true });
	try {
		const extracted = spawnSync("tar", ["-xf", archive.liveArchivePath, "-C", stage], { encoding: "utf8" });
		if (extracted.status !== 0) throw new Error(extracted.stderr || "live archive restore failed");
		for (const entry of readdirSync(join(stage, "worktree")))
			copyTree(join(stage, "worktree", entry), join(target, entry));
		copyTree(join(stage, "git"), join(target, ".git"));
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export function retireVerifiedRootGit(archive: RootGitArchive, confirmation: string): void {
	if (confirmation !== "RETIRE ROOT GIT") throw new Error("explicit confirmation required: RETIRE ROOT GIT");
	if (!existsSync(archive.verificationPath)) throw new Error("archive must be verified before retirement");
	const inventory = inspectRootGit(archive.root);
	if (inventory.mode !== "shell") throw new Error("refusing retirement: root Git is not managed shell mode");
	const result = spawnSync("git", ["-C", archive.root, "update-ref", "-d", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || "retirement failed");
}
