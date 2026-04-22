import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SIGNET_SECRETS_PLUGIN_ID,
	type SetupDetection,
	readGraphiqState,
	updateGraphiqActiveProject,
} from "@signet/core";
import { runExistingSetupWizard } from "./setup-migrate.js";
import type { SetupDeps } from "./setup-types.js";
import { setupWizard } from "./setup.js";

const NO_HARNESSES = {
	claudeCode: false,
	openclaw: false,
	opencode: false,
	codex: false,
	ohMyPi: false,
	pi: false,
	forge: false,
	hermesAgent: false,
};

function fakeDetection(basePath = "/tmp/agents"): SetupDetection {
	return {
		basePath,
		agentsDir: true,
		agentYaml: false,
		agentsMd: false,
		configYaml: false,
		memoryDb: true,
		identityFiles: [],
		hasMemoryDir: false,
		memoryLogCount: 0,
		hasClawdhub: false,
		hasClaudeSkills: false,
		harnesses: { ...NO_HARNESSES },
	};
}

function stubDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
	return {
		AGENTS_DIR: "/tmp/agents",
		DEFAULT_PORT: 4100,
		configureHarnessHooks: mock(async () => {}),
		copyDirRecursive: mock(() => {}),
		detectExistingSetup: mock(() => fakeDetection()),
		gitAddAndCommit: mock(async () => false),
		getTemplatesDir: mock(() => "/tmp/templates"),
		gitInit: mock(async () => false),
		importFromGitHub: mock(async () => {}),
		isDaemonRunning: mock(async () => true),
		isGitRepo: mock(() => false),
		launchDashboard: mock(async () => {}),
		normalizeAgentPath: mock((p: string) => p),
		normalizeChoice: mock(<T extends string>(value: unknown, allowed: readonly T[]) => {
			const s = String(value);
			return (allowed as readonly string[]).includes(s) ? (s as T) : null;
		}),
		normalizeStringValue: mock((v: unknown) => (typeof v === "string" ? v : null)),
		parseIntegerValue: mock(() => null),
		parseSearchBalanceValue: mock(() => null),
		showStatus: mock(async () => {}),
		signetLogo: mock(() => ""),
		startDaemon: mock(async () => true),
		getSkillsSourceDir: mock(() => "/tmp/skills"),
		syncBuiltinSkills: mock(() => ({ installed: [], updated: [], skipped: [] })),
		syncWorkspaceSourceRepo: mock(async () => ({
			status: "current" as const,
			path: "/tmp/agents/signetai",
			message: "current",
			branch: "main",
			defaultBranch: "main",
		})),
		...overrides,
	};
}

describe("setupWizard non-interactive harness hooks", () => {
	let root: string;

	afterEach(() => {
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("installs requested harness hooks for each harness", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-hooks-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });

		const configureHarnessHooks = mock(async (_harness: string, _path: string) => {});
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			configureHarnessHooks,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => fakeDetection(basePath)),
		});

		await setupWizard({ nonInteractive: true, harness: ["pi", "claude-code"] }, deps);

		expect(configureHarnessHooks.mock.calls).toEqual([
			["pi", basePath],
			["claude-code", basePath],
		]);
	});

	it("warns but does not throw when hook installation fails", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-fail-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });

		const configureHarnessHooks = mock(async () => {
			throw new Error("permission denied");
		});

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				configureHarnessHooks,
				normalizeAgentPath: mock((p: string) => p),
				detectExistingSetup: mock(() => fakeDetection(basePath)),
			});

			await setupWizard({ nonInteractive: true, harness: ["pi"] }, deps);

			expect(configureHarnessHooks).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalled();

			const warnArg = warnSpy.mock.calls[0]?.[0] as string;
			expect(warnArg).toContain("pi");
			expect(warnArg).toContain("permission denied");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("warns per-harness when multiple hooks fail independently", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-multi-fail-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });

		const configureHarnessHooks = mock(async (harness: string) => {
			throw new Error(`${harness} broke`);
		});

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				configureHarnessHooks,
				normalizeAgentPath: mock((p: string) => p),
				detectExistingSetup: mock(() => fakeDetection(basePath)),
			});

			await setupWizard({ nonInteractive: true, harness: ["pi", "claude-code"] }, deps);

			expect(configureHarnessHooks.mock.calls).toEqual([
				["pi", basePath],
				["claude-code", basePath],
			]);
			expect(warnSpy).toHaveBeenCalledTimes(2);

			const warnings = warnSpy.mock.calls.map((c) => c[0] as string);
			expect(warnings[0]).toContain("pi broke");
			expect(warnings[1]).toContain("claude-code broke");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("skips hook installation when no harnesses are requested", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-no-harness-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });

		const configureHarnessHooks = mock(async () => {});
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			configureHarnessHooks,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => fakeDetection(basePath)),
		});

		await setupWizard({ nonInteractive: true }, deps);

		expect(configureHarnessHooks).not.toHaveBeenCalled();
	});

	it("persists disabled signet secrets when existing non-interactive setup opts out", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-secrets-disabled-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => fakeDetection(basePath)),
		});

		await setupWizard({ nonInteractive: true, disableSignetSecrets: true }, deps);

		const registry = JSON.parse(readFileSync(join(basePath, ".daemon", "plugins", "registry-v1.json"), "utf-8"));
		expect(registry.plugins[SIGNET_SECRETS_PLUGIN_ID].enabled).toBe(false);
	});

	it("disables persisted GraphIQ state when existing non-interactive setup opts out", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-graphiq-disabled-"));
		const basePath = join(root, "agents");
		const projectPath = join(root, "project");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(projectPath, { recursive: true });
		updateGraphiqActiveProject(basePath, {
			projectPath,
			indexedAt: new Date("2026-04-21T00:00:00.000Z"),
			installSource: "existing",
		});

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => fakeDetection(basePath)),
		});

		await setupWizard({ nonInteractive: true, disableGraphiq: true }, deps);

		const state = readGraphiqState(basePath);
		expect(state.enabled).toBe(false);
		expect(state.activeProject).toBe(projectPath);
	});

	it("disables persisted GraphIQ state when migrated identity setup opts out", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-graphiq-disabled-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		const projectPath = join(root, "project");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(templatesPath, { recursive: true });
		mkdirSync(projectPath, { recursive: true });
		updateGraphiqActiveProject(basePath, {
			projectPath,
			indexedAt: new Date("2026-04-21T00:00:00.000Z"),
			installSource: "existing",
		});

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			isGitRepo: mock(() => true),
		});

		await runExistingSetupWizard(basePath, fakeDetection(basePath), {}, deps, {
			nonInteractive: true,
			skipGit: true,
			allowUnprotectedWorkspace: true,
			signetSecretsEnabled: true,
			graphiqEnabled: false,
		});

		const state = readGraphiqState(basePath);
		expect(state.enabled).toBe(false);
		expect(state.activeProject).toBe(projectPath);
	});

	it("fails fast on unknown non-interactive harness values in the existing-install path", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-invalid-harness-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});

		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				normalizeAgentPath: mock((p: string) => p),
				detectExistingSetup: mock(() => fakeDetection(basePath)),
			});

			await expect(setupWizard({ nonInteractive: true, harness: ["pi,nope"] }, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy).toHaveBeenCalled();
			expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("Unknown --harness value(s): nope");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});
