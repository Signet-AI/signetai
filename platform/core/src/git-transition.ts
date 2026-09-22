import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mergeSignetGitignoreEntries } from "./gitignore";

export type RootGitMode = "absent" | "shell" | "unmanaged";
export interface RootGitInventory {
	readonly mode: RootGitMode;
	readonly isRepository: boolean;
	readonly branch: string | null;
	readonly remotes: readonly string[];
	readonly dirty: boolean;
	readonly staged: boolean;
	readonly untracked: boolean;
}
export type ManagedGitignoreUpdate =
	| { readonly status: "updated"; readonly preimage: string; readonly content: string }
	| { readonly status: "refused"; readonly reason: "dirty" | "staged" };

function git(root: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

export function inspectRootGit(root: string): RootGitInventory {
	const isRepository = git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
	if (!isRepository)
		return {
			mode: "absent",
			isRepository: false,
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
	const inventory = inspectRootGit(root);
	if (
		inventory.isRepository &&
		inventory.staged &&
		git(root, ["diff", "--cached", "--name-only"]).split("\n").includes(".gitignore")
	) {
		return { status: "refused", reason: "staged" };
	}
	if (inventory.isRepository && git(root, ["diff", "--name-only"]).split("\n").includes(".gitignore")) {
		return { status: "refused", reason: "dirty" };
	}
	const preimage = existsSync(path) ? readFileSync(path, "utf8") : "";
	const content = mergeSignetGitignoreEntries(preimage);
	if (content !== preimage) writeFileSync(path, content, "utf8");
	return { status: "updated", preimage, content };
}
