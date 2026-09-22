import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "./workspace-layout";
import type { ProtectionComponent, ProtectionComponentId } from "./protection";

export interface ProtectionEvidence {
	readonly components: readonly ProtectionComponent[];
}
export interface ProtectionEvidenceOptions {
	readonly now?: Date;
	readonly externalKeyringAvailable?: boolean;
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
	const rootAuthored = present(layout.files) && present(layout.layoutFile);
	const skills = present(layout.skills);
	const originals = hasVerifiedBackup(rootPath, ["backup", ".backup", "originals", "managed-originals"]);
	const sqlite = present(layout.database) && hasVerifiedBackup(rootPath, ["backup", ".backup", "snapshots"]);
	const transcripts =
		present(layout.transcripts) && hasVerifiedBackup(rootPath, ["backup", ".backup", "transcript-backup", "snapshots"]);
	const sourceOwner = present(join(layout.files, "sources.json"));
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
				sourceOwner ? "protected" : "missing",
				sourceOwner ? "external source owner is recorded" : "external source owner is missing",
			),
			component(
				"runtime",
				runtime ? "protected" : "unverified",
				runtime ? "runtime recreation was proven" : "runtime recreation proof is missing",
			),
			component("filesystem-cache", "excluded-rebuildable", "filesystem cache is rebuildable from authoritative state"),
			component(
				"secrets",
				keyring || present(layout.secrets) ? "protected" : "unverified",
				keyring
					? "external keyring is available"
					: present(layout.secrets)
						? "encrypted file provider is present"
						: "encrypted provider is unavailable",
			),
		],
	};
}
