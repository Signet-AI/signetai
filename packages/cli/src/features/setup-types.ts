import type { SetupDetection } from "@signet/core";
import type { OpenClawRuntimeChoice } from "./setup-shared.js";

export interface SetupWizardOptions {
	path?: string;
	nonInteractive?: boolean;
	name?: string;
	description?: string;
	harness?: string[];
	embeddingProvider?: string;
	embeddingModel?: string;
	extractionProvider?: string;
	extractionModel?: string;
	searchBalance?: string;
	skipGit?: boolean;
	openDashboard?: boolean;
	openclawRuntimePath?: string;
	configureOpenclawWorkspace?: boolean;
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
	readonly syncBuiltinSkills: (
		templatesDir: string,
		basePath: string,
	) => { installed: string[]; updated: string[]; skipped: string[] };
}
