import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupDetection } from "@signet/core";
import type { SetupDeps } from "./setup-types.js";
import { setupWizard } from "./setup.js";

const originalOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;

afterEach(() => {
	if (originalOpenClawConfig === undefined) {
		process.env.OPENCLAW_CONFIG_PATH = undefined;
	} else {
		process.env.OPENCLAW_CONFIG_PATH = originalOpenClawConfig;
	}
});

function detection(basePath: string): SetupDetection {
	return {
		basePath,
		agentsDir: true,
		agentYaml: true,
		agentsMd: true,
		configYaml: false,
		memoryDb: true,
		identityFiles: [],
		hasMemoryDir: false,
		memoryLogCount: 0,
		hasClawdhub: false,
		hasClaudeSkills: false,
		harnesses: {
			claudeCode: false,
			openclaw: false,
			opencode: false,
			codex: false,
			ohMyPi: false,
			forge: false,
		},
	};
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
	if (typeof value !== "string") {
		return null;
	}
	for (const item of allowed) {
		if (item === value) {
			return item;
		}
	}
	return null;
}

function deps(basePath: string): SetupDeps {
	return {
		AGENTS_DIR: basePath,
		DEFAULT_PORT: 3850,
		configureHarnessHooks: async () => {},
		copyDirRecursive: () => {},
		detectExistingSetup: () => detection(basePath),
		gitAddAndCommit: async () => false,
		getTemplatesDir: () => basePath,
		gitInit: async () => true,
		importFromGitHub: async () => {},
		isDaemonRunning: async () => true,
		isGitRepo: () => true,
		launchDashboard: async () => {},
		normalizeAgentPath: (pathValue) => pathValue,
		normalizeChoice: pick,
		normalizeStringValue: (value) => (typeof value === "string" ? value : null),
		parseIntegerValue: (value) => (typeof value === "number" ? value : null),
		parseSearchBalanceValue: (value) => (typeof value === "number" ? value : null),
		showStatus: async () => {},
		signetLogo: () => "",
		startDaemon: async () => true,
		syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
	};
}

describe("setup non-interactive protection checks", () => {
	it("fails existing-install path when openclaw-linked workspace is unprotected", async () => {
		const root = mkdtempSync(join(tmpdir(), "setup-existing-"));
		const workspace = join(root, "agents");
		try {
			mkdirSync(workspace, { recursive: true });
			const cfgPath = join(root, "openclaw.json");
			writeFileSync(
				cfgPath,
				JSON.stringify({
					agents: {
						defaults: {
							workspace,
						},
					},
				}),
			);
			process.env.OPENCLAW_CONFIG_PATH = cfgPath;

			await expect(
				setupWizard(
					{
						nonInteractive: true,
						path: workspace,
					},
					deps(workspace),
				),
			).rejects.toThrow("OpenClaw workspace is linked");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
