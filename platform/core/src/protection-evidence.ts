import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "./workspace-layout";
import type { ProtectionComponent, ProtectionComponentId } from "./protection";

export interface ProtectionEvidence {
	readonly components: readonly ProtectionComponent[];
}
const DIGEST_LIMIT = 20_000;
function canonicalDigest(paths: readonly string[]): string {
	const hash = createHash("sha256");
	let count = 0;
	const visit = (path: string, relativePath: string) => {
		if (count++ >= DIGEST_LIMIT) return;
		try {
			if (lstatSync(path).isSymbolicLink()) return;
			if (statSync(path).isDirectory()) {
				for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name));
			} else hash.update(`file:${relativePath}:`).update(readFileSync(path)).update("\\0");
		} catch {
			hash.update(`missing:${relativePath}\\0`);
		}
	};
	for (const path of paths) visit(path, path);
	return hash.digest("hex");
}

/** Hashes only authoritative current content; runtime receipts and rebuildable cache are excluded. */
export function computeProtectionDigests(rootPath: string): Readonly<Record<string, string>> {
	const layout = resolveWorkspaceLayout(rootPath);
	const originalDirs = ["backup", ".backup", "originals", "managed-originals"].map((name) => join(rootPath, name));
	const snapshotDirs = ["backup", ".backup", "snapshots"].map((name) => join(rootPath, name));
	return {
		"root-authored": canonicalDigest([layout.layoutFile, ...ROOT_AUTHORED_FILES.map((file) => join(rootPath, file))]),
		skills: canonicalDigest([layout.skills]),
		"managed-originals": canonicalDigest(originalDirs),
		sqlite: canonicalDigest([layout.database, ...snapshotDirs]),
		transcripts: canonicalDigest([layout.transcripts, ...snapshotDirs]),
		"external-sources": canonicalDigest([join(rootPath, "sources.json")]),
		runtime: canonicalDigest([join(layout.runtime, ".recreate-proof")]),
		secrets: canonicalDigest([layout.secrets]),
	};
}
export interface ProtectionEvidenceOptions {
	readonly now?: Date;
	readonly externalKeyringAvailable?: boolean;
	readonly rootGitProtected?: boolean;
	readonly skillsGitProtected?: boolean;
}
function component(
	id: ProtectionComponentId,
	status: ProtectionComponent["status"],
	detail: string,
): ProtectionComponent {
	return { id, status, detail };
}
function present(path: string): boolean {
	return existsSync(path);
}
const ROOT_AUTHORED_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "agent.yaml", ".sigignore"] as const;
function hasVerifiedBackup(root: string, names: readonly string[]): boolean {
	for (const name of names) {
		const candidate = join(root, name);
		const receipt = join(candidate, ".signet-receipt.json");
		try {
			if (!statSync(candidate).isDirectory()) continue;
			const parsed = JSON.parse(readFileSync(receipt, "utf8")) as {
				workspace?: unknown;
				checksum?: unknown;
				components?: unknown;
			};
			if (parsed.workspace === root && typeof parsed.checksum === "string" && Array.isArray(parsed.components))
				return true;
		} catch {
			// Unverified directories are not protection evidence.
		}
	}
	return false;
}

export function buildProtectionEvidence(rootPath: string, options: ProtectionEvidenceOptions = {}): ProtectionEvidence {
	const layout = resolveWorkspaceLayout(rootPath);
	const rootAuthored =
		present(layout.layoutFile) &&
		ROOT_AUTHORED_FILES.every((file) => present(join(rootPath, file))) &&
		options.rootGitProtected === true;
	const skills = present(layout.skills) && options.skillsGitProtected === true;
	const originals = hasVerifiedBackup(rootPath, ["backup", ".backup", "originals", "managed-originals"]);
	const sqlite = present(layout.database) && hasVerifiedBackup(rootPath, ["backup", ".backup", "snapshots"]);
	const transcripts =
		present(layout.transcripts) && hasVerifiedBackup(rootPath, ["backup", ".backup", "transcript-backup", "snapshots"]);
	const sourceOwner = present(join(rootPath, "sources.json"));
	const runtime = present(layout.runtime) && present(join(layout.runtime, ".recreate-proof"));
	const keyring =
		options.externalKeyringAvailable === true ||
		process.env.SIGNET_KEYRING_AVAILABLE === "1" ||
		process.env.SIGNET_EXTERNAL_KEYRING === "1";
	return {
		components: [
			component(
				"root-authored",
				rootAuthored ? "protected" : "missing",
				rootAuthored ? "workspace layout and authored files present" : "authored workspace state is incomplete",
			),
			component(
				"skills",
				skills ? "protected" : "missing",
				skills ? "independent skills repository present" : "independent skills repository is missing",
			),
			component(
				"managed-originals",
				originals ? "protected" : "missing",
				originals ? "managed originals retention is present" : "managed originals retention is missing",
			),
			component(
				"sqlite",
				sqlite ? "protected" : "missing",
				sqlite ? "database snapshot evidence is present" : "database snapshot evidence is missing",
			),
			component(
				"transcripts",
				transcripts ? "protected" : "missing",
				transcripts ? "transcript backup evidence is present" : "transcript backup evidence is missing",
			),
			component(
				"external-sources",
				sourceOwner ? "external" : "protected",
				sourceOwner ? "external source ownership requires independent verification" : "no external sources configured",
			),
			component(
				"runtime",
				runtime ? "protected" : "unverified",
				runtime ? "runtime recreation was proven" : "runtime recreation proof is missing",
			),
			component("filesystem-cache", "excluded-rebuildable", "filesystem cache is rebuildable from authoritative state"),
			component(
				"secrets",
				keyring ? "protected" : "unverified",
				keyring
					? "external keyring is available"
					: present(layout.secrets)
						? "encrypted file provider has no verified recovery evidence"
						: "encrypted provider is unavailable",
			),
		],
	};
}
