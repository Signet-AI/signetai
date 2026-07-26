import type { SetupDetection, WorkspaceSourceRepoSyncResult } from "@signet/core";
import type { OpenClawRuntimeChoice } from "./setup-shared.js";

export interface SetupWizardOptions {
	path?: string;
	nonInteractive?: boolean;
	name?: string;
	description?: string;
	deploymentType?: string;
	networkMode?: string;
	harness?: string[];
	embeddingProvider?: string;
	embeddingModel?: string;
	extractionProvider?: string;
	extractionModel?: string;
	extractionEndpoint?: string;
	searchBalance?: string;
	skipGit?: boolean;
	openDashboard?: boolean;
	openclawRuntimePath?: string;
	configureOpenclawWorkspace?: boolean;
	allowUnprotectedWorkspace?: boolean;
	createLocalBackup?: boolean;
	disableSignetSecrets?: boolean;
	withGraphiq?: boolean;
	disableGraphiq?: boolean;
	identityPreset?: string;
	identityMode?: string;
	schema?: boolean;
}

export interface SetupDeps {
	readonly AGENTS_DIR: string;
	readonly DEFAULT_PORT: number;
	readonly configureHarnessHooks: (
		harness: string,
		basePath: string,
		options?: {
			configureOpenClawWorkspace?: boolean;
			openclawRuntimePath?: OpenClawRuntimeChoice;
		},
	) => Promise<void>;
	readonly copyDirRecursive: (src: string, dest: string) => void;
	readonly detectExistingSetup: (basePath: string) => SetupDetection;
	readonly gitAddAndCommit: (dir: string, message: string) => Promise<boolean>;
	readonly getTemplatesDir: () => string;
	readonly gitInit: (dir: string) => Promise<boolean>;
	readonly importFromGitHub: (basePath: string) => Promise<void>;
	readonly isDaemonRunning: () => Promise<boolean>;
	readonly isGitRepo: (dir: string) => boolean;
	readonly launchDashboard: (options: { path?: string }) => Promise<void>;
	readonly normalizeAgentPath: (pathValue: string) => string;
	readonly normalizeChoice: <T extends string>(value: unknown, allowed: readonly T[]) => T | null;
	readonly normalizeStringValue: (value: unknown) => string | null;
	readonly parseIntegerValue: (value: unknown) => number | null;
	readonly parseSearchBalanceValue: (value: unknown) => number | null;
	readonly showStatus: (options: { path?: string; json?: boolean }) => Promise<void>;
	readonly signetLogo: () => string;
	readonly startDaemon: (agentsDir?: string) => Promise<boolean>;
	readonly getSkillsSourceDir: () => string;
	readonly syncBuiltinSkills: (
		skillsSourceDir: string,
		basePath: string,
	) => { installed: string[]; updated: string[]; skipped: string[] };
	readonly syncWorkspaceSourceRepo: (basePath: string) => Promise<WorkspaceSourceRepoSyncResult>;
	readonly syncNativeEmbeddingModel: (
		basePath: string,
	) => Promise<{ readonly status: "updated" | "current" | "skipped" | "error"; readonly message: string }>;
	readonly loadConfiguredHarnesses?: (basePath: string) => readonly string[];
}
