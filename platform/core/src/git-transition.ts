import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mergeSignetGitignoreEntries } from "./gitignore";

export type RootGitMode = "absent" | "shell" | "unmanaged";
export interface RootGitInventory {
	readonly mode: RootGitMode;
	readonly root: string;
	readonly isRootRepository: boolean;
	readonly head: string | null;
	readonly indexChanged: boolean;
	readonly worktreeChanged: boolean;
	readonly hooks: readonly string[];
	readonly localConfig: boolean;
	readonly isRepository: boolean;
	readonly branch: string | null;
	readonly remotes: readonly string[];
	readonly dirty: boolean;
	readonly staged: boolean;
	readonly untracked: boolean;
}
export type ManagedGitignoreUpdate =
	| { readonly status: "updated"; readonly preimage: string; readonly content: string }
	| {
			readonly status: "refused";
			readonly reason: "dirty" | "staged";
			readonly preimage: string;
			readonly content: string;
	  };

function git(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

export function inspectRootGit(root: string): RootGitInventory {
	const resolvedRoot = git(root, ["rev-parse", "--show-toplevel"]);
	const isRepository = resolvedRoot.length > 0;
	const isRootRepository = isRepository && resolvedRoot === root;
	if (!isRepository || !isRootRepository)
		return {
			mode: isRepository ? "unmanaged" : "absent",
			root,
			isRootRepository: false,
			head: null,
			indexChanged: false,
			worktreeChanged: false,
			hooks: [],
			localConfig: false,
			isRepository,
			branch: null,
			remotes: [],
			dirty: false,
			staged: false,
			untracked: false,
		};
	const porcelain = git(root, ["status", "--porcelain=v1"]);
	const lines = porcelain ? porcelain.split("\n") : [];
	const staged = lines.some((line) => line[0] !== " " && line[0] !== "?" && line[0] !== "!");
	const untracked = lines.some((line) => line.startsWith("??"));
	const dirty = lines.length > 0;
	const remotes = git(root, ["remote"]).split("\n").filter(Boolean);
	const ignore = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
	const mode: RootGitMode = ignore.includes("# BEGIN Signet lightweight workspace") ? "shell" : "unmanaged";
	return {
		mode,
		root,
		isRootRepository: true,
		head: git(root, ["rev-parse", "HEAD"]) || null,
		indexChanged: staged,
		worktreeChanged: dirty && !staged,
		hooks: existsSync(join(root, ".git", "hooks"))
			? readdirSync(join(root, ".git", "hooks")).filter((name) => !name.endsWith(".sample"))
			: [],
		localConfig: existsSync(join(root, ".git", "config")),
		isRepository: true,
		branch: git(root, ["branch", "--show-current"]) || null,
		remotes,
		dirty,
		staged,
		untracked,
	};
}

export function managedGitignoreUpdate(root: string): ManagedGitignoreUpdate {
	const path = join(root, ".gitignore");
	const preimage = existsSync(path) ? readFileSync(path, "utf8") : "";
	const content = mergeSignetGitignoreEntries(preimage);
	const inventory = inspectRootGit(root);
	const stagedIgnore =
		inventory.isRepository && git(root, ["diff", "--cached", "--name-only"]).split("\n").includes(".gitignore");
	const dirtyIgnore = inventory.isRepository && git(root, ["diff", "--name-only"]).split("\n").includes(".gitignore");
	if (stagedIgnore) return { status: "refused", reason: "staged", preimage, content };
	if (dirtyIgnore) return { status: "refused", reason: "dirty", preimage, content };
	if (content !== preimage) writeFileSync(path, content, "utf8");
	return { status: "updated", preimage, content };
}
