import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "./workspace-layout";
import type { ProtectionComponent, ProtectionComponentId, ProtectionState } from "./protection";

export interface ProtectionEvidence {
	readonly components: readonly ProtectionComponent[];
}

export interface ProtectionEvidenceOptions {
	readonly now?: Date;
	readonly externalKeyringAvailable?: boolean;
	readonly restoreVerifiedAt?: string;
	readonly verifiedScope?: string;
}

const required = new Set<ProtectionComponentId>([
	"root-authored",
	"skills",
	"managed-originals",
	"sqlite",
	"transcripts",
	"external-sources",
	"secrets",
]);

const mechanism: Record<ProtectionComponentId, string> = {
	"root-authored": "git-or-versioned-backup",
	skills: "independent-git",
	"managed-originals": "component-backup",
	sqlite: "sqlite-snapshot",
	transcripts: "file-backup",
	"external-sources": "external-owner",
	runtime: "recreate",
	"filesystem-cache": "rebuild",
	secrets: "encrypted-provider",
};

function component(
	id: ProtectionComponentId,
	state: ProtectionState,
	reason: string,
	options: ProtectionEvidenceOptions,
	backupAt?: string,
): ProtectionComponent {
	const excluded = id === "runtime" || id === "filesystem-cache";
	return {
		id,
		type: id,
		authority:
			id === "external-sources" || id === "secrets"
				? "external"
				: id === "root-authored" || id === "skills"
					? "user"
					: "daemon",
		location: "[redacted]",
		mechanism: mechanism[id],
		state,
		required: required.has(id),
		intentionallyExcluded: excluded,
		backupAt,
		restoreVerifiedAt: state === "protected" ? options.restoreVerifiedAt : undefined,
		verifiedScope: state === "protected" ? options.verifiedScope : undefined,
		reason,
	};
}

function populated(path: string): boolean {
	try {
		return readdirSync(path).length > 0;
	} catch {
		return false;
	}
}

export function buildProtectionEvidence(rootPath: string, options: ProtectionEvidenceOptions = {}): ProtectionEvidence {
	const layout = resolveWorkspaceLayout(rootPath);
	const rootGit = existsSync(join(layout.root, ".git"));
	const skillsGit = existsSync(join(layout.skills, ".git"));
	const importsPresent = populated(layout.imports);
	const snapshots = join(layout.data, "snapshots");
	const snapshotEvidence = populated(snapshots);
	const transcriptsPresent = populated(layout.transcripts);
	const transcriptBackupEvidence = populated(join(layout.data, "transcript-backups"));
	const externalOwnerRecorded = existsSync(join(layout.root, "sources.json"));
	const keyring = options.externalKeyringAvailable === true || process.env.SIGNET_KEYRING_AVAILABLE === "1";
	const restoreAt = options.restoreVerifiedAt;

	return {
		components: [
			component(
				"root-authored",
				rootGit ? "protected" : "missing",
				rootGit ? "root repository is present" : "root authored backup is missing",
				options,
			),
			component(
				"skills",
				skillsGit ? "protected" : "missing",
				skillsGit ? "independent skills repository is present" : "independent skills repository is missing",
				options,
			),
			component(
				"managed-originals",
				importsPresent ? (snapshotEvidence ? "protected" : "missing") : "protected",
				importsPresent
					? snapshotEvidence
						? "managed originals backup evidence is present"
						: "managed originals are not backed up"
					: "no managed originals require protection",
				options,
			),
			component(
				"sqlite",
				snapshotEvidence ? "protected" : "missing",
				snapshotEvidence ? "database snapshot evidence is present" : "database snapshot evidence is missing",
				options,
			),
			component(
				"transcripts",
				transcriptsPresent ? (transcriptBackupEvidence ? "protected" : "missing") : "protected",
				transcriptsPresent
					? transcriptBackupEvidence
						? "transcript backup evidence is present"
						: "transcripts are not backed up"
					: "no transcripts require protection",
				options,
			),
			component(
				"external-sources",
				externalOwnerRecorded ? "protected" : "unknown",
				externalOwnerRecorded ? "external source ownership is recorded" : "external source protection is unknown",
				options,
			),
			component("runtime", "protected", "runtime is intentionally recreated", options),
			component("filesystem-cache", "protected", "filesystem cache is intentionally rebuildable", options),
			component(
				"secrets",
				keyring ? "protected" : "unknown",
				keyring ? "external keyring availability was verified" : "secret provider continuity is unverified",
				options,
			),
		].map((entry) =>
			entry.state === "protected" && restoreAt
				? { ...entry, restoreVerifiedAt: restoreAt, verifiedScope: options.verifiedScope ?? "component" }
				: entry,
		),
	};
}
