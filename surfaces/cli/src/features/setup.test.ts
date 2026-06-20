import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SIGNET_SECRETS_PLUGIN_ID,
	type SetupDetection,
	detectExistingSetup,
	readGraphiqState,
	updateGraphiqActiveProject,
} from "@signet/core";
import { detectedHarnessesForExistingSetup, runExistingSetupWizard } from "./setup-migrate.js";
import type { SetupDeps } from "./setup-types.js";
import { setupWizard } from "./setup.js";

const NO_HARNESSES = {
	claudeCode: false,
	openclaw: false,
	opencode: false,
	forge: false,
	codex: false,
	ohMyPi: false,
	pi: false,
	hermesAgent: false,
	gemini: false,
};

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HERMES_REPO = process.env.HERMES_REPO;
const ORIGINAL_HERMES_HOME = process.env.HERMES_HOME;

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
		syncNativeEmbeddingModel: mock(async () => ({ status: "current" as const, message: "ready" })),
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

function writeIdentityTemplates(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const name of [
		"AGENTS.md",
		"SOUL.md",
		"IDENTITY.md",
		"USER.md",
		"MEMORY.md",
		"DREAMING.md",
		"HEARTBEAT.md",
		"BOOTSTRAP.md",
	]) {
		writeFileSync(join(dir, `${name}.template`), `${name} for {{AGENT_NAME}}`);
	}
}

describe("setupWizard non-interactive harness hooks", () => {
	let root: string;

	afterEach(() => {
		if (ORIGINAL_HOME === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined"
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
		if (ORIGINAL_HERMES_REPO === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined"
			delete process.env.HERMES_REPO;
		} else {
			process.env.HERMES_REPO = ORIGINAL_HERMES_REPO;
		}
		if (ORIGINAL_HERMES_HOME === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined"
			delete process.env.HERMES_HOME;
		} else {
			process.env.HERMES_HOME = ORIGINAL_HERMES_HOME;
		}
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

	it("writes OpenAI-compatible endpoint during non-interactive setup", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-compatible-endpoint-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(templatesPath, { recursive: true });

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({
				...fakeDetection(basePath),
				agentsDir: false,
				memoryDb: false,
				hasMemoryDir: false,
			})),
		});

		await setupWizard(
			{
				nonInteractive: true,
				extractionProvider: "openai-compatible",
				extractionModel: "openai/gpt-oss-20b",
				extractionEndpoint: "https://gateway.example.test/v1",
				skipGit: true,
			},
			deps,
		);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("provider: openai-compatible");
		expect(agentYaml).toContain("model: openai/gpt-oss-20b");
		expect(agentYaml).toContain("endpoint: https://gateway.example.test/v1");
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

	it("includes Hermes in migration harnesses when detected in ~/.hermes", () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-hermes-default-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(root, ".hermes", "plugins", "memory"), { recursive: true });
		process.env.HOME = root;
		// biome-ignore lint/performance/noDelete: default ~/.hermes must be enough
		delete process.env.HERMES_REPO;
		// biome-ignore lint/performance/noDelete: default ~/.hermes must be enough
		delete process.env.HERMES_HOME;

		const detection = detectExistingSetup(basePath);
		expect(detection.harnesses.hermesAgent).toBe(true);
		expect(detectedHarnessesForExistingSetup(detection, [])).toContain("hermes-agent");
	});

	it("includes ForgeCode in migration harnesses when detected in ~/.forge", () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-forge-default-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(root, ".forge"), { recursive: true });
		writeFileSync(join(root, ".forge", ".mcp.json"), "{}\n");
		process.env.HOME = root;

		const detection = detectExistingSetup(basePath);
		expect(detection.harnesses.forge).toBe(true);
		expect(detectedHarnessesForExistingSetup(detection, [])).toContain("forge");
	});

	it("writes minimal identity preset with DREAMING.md as special-session file", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-minimal-identity-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);

		const freshDetection: SetupDetection = {
			...fakeDetection(basePath),
			agentsDir: false,
			memoryDb: false,
		};
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection),
		});

		await setupWizard({ nonInteractive: true, identityPreset: "minimal", skipGit: true }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("preset: minimal");
		expect(agentYaml).toContain("path: AGENTS.md");
		expect(agentYaml).toContain("path: DREAMING.md");
		expect(agentYaml).toContain("kind: dreaming");
		expect(existsSync(join(basePath, "AGENTS.md"))).toBe(true);
		expect(existsSync(join(basePath, "DREAMING.md"))).toBe(true);
		expect(existsSync(join(basePath, "SOUL.md"))).toBe(false);
	});

	it("writes custom identity preset with concrete files for every referenced path", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-custom-identity-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);

		const freshDetection: SetupDetection = {
			...fakeDetection(basePath),
			agentsDir: false,
			memoryDb: false,
		};
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection),
		});

		await setupWizard({ nonInteractive: true, identityPreset: "custom", skipGit: true }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("preset: custom");
		for (const name of ["AGENTS.md", "DREAMING.md"]) {
			expect(agentYaml).toContain(`path: ${name}`);
			expect(existsSync(join(basePath, name))).toBe(true);
		}
		expect(existsSync(join(basePath, "SOUL.md"))).toBe(false);
	});

	it("writes memory and secrets capabilities without identity files when identity mode is off", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-identity-off-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);

		const freshDetection: SetupDetection = {
			...fakeDetection(basePath),
			agentsDir: false,
			memoryDb: false,
		};
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection),
		});

		await setupWizard({ nonInteractive: true, identityMode: "off", skipGit: true }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("capabilities:");
		expect(agentYaml).toContain("identity:");
		expect(agentYaml).toContain("mode: off");
		expect(agentYaml).toContain("memory:");
		expect(agentYaml).toContain("secrets:");
		expect(agentYaml).not.toContain("preset:");
		for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "DREAMING.md"]) {
			expect(existsSync(join(basePath, name))).toBe(false);
		}
		expect(existsSync(join(basePath, "memory", "memories.db"))).toBe(true);
	});

	it("writes every openclaw special-session file referenced by the identity preset", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-openclaw-identity-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);

		const freshDetection: SetupDetection = {
			...fakeDetection(basePath),
			agentsDir: false,
			memoryDb: false,
		};
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection),
		});

		await setupWizard({ nonInteractive: true, identityPreset: "openclaw", skipGit: true }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		for (const name of [
			"AGENTS.md",
			"SOUL.md",
			"IDENTITY.md",
			"USER.md",
			"MEMORY.md",
			"HEARTBEAT.md",
			"DREAMING.md",
			"BOOTSTRAP.md",
		]) {
			expect(agentYaml).toContain(`path: ${name}`);
			expect(existsSync(join(basePath, name))).toBe(true);
		}
	});

	it("fails fast on unknown non-interactive identity modes", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-invalid-identity-mode-"));
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

			await expect(setupWizard({ nonInteractive: true, identityMode: "ghost" }, deps)).rejects.toThrow(
				"process.exit:1",
			);
			expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("Unknown --identity-mode value: ghost");
		} finally {
			errorSpy.mockRestore();
			exitSpy.mockRestore();
		}
	});

	it("fails fast on unknown non-interactive identity presets", async () => {
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

			await expect(setupWizard({ nonInteractive: true, identityPreset: "maximalist" }, deps)).rejects.toThrow(
				"process.exit:1",
			);
			expect(errorSpy).toHaveBeenCalled();
			expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain("Unknown --identity-preset value: maximalist");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("scaffolds identity files when switching from off to managed", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-off-to-managed-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
		// Write initial agent.yaml with identity mode off
		writeFileSync(
			join(basePath, "agent.yaml"),
			"capabilities:\n  identity:\n    mode: off\n  memory: {}\n  secrets: {}\n",
		);
		writeFileSync(join(basePath, "memory", "memories.db"), "");

		const configureHarnessHooks = mock(async () => {});
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			configureHarnessHooks,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({
				...fakeDetection(basePath),
				agentYaml: true,
				memoryDb: true,
			})),
		});

		await setupWizard({ nonInteractive: true, identityMode: "managed", skipGit: true }, deps);

		// All required identity files should be scaffolded
		for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
			expect(existsSync(join(basePath, name))).toBe(true);
		}
		const agentsContent = readFileSync(join(basePath, "AGENTS.md"), "utf-8");
		expect(agentsContent).toContain("Agent Instructions");

		// agent.yaml should now have managed mode
		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("mode: managed");
	});

	it("runs connector cleanup when switching from managed to off", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-managed-to-off-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
		// Write initial agent.yaml with identity mode managed
		writeFileSync(
			join(basePath, "agent.yaml"),
			"capabilities:\n  identity:\n    mode: managed\n  memory: {}\n  secrets: {}\nharnesses:\n  - opencode\n",
		);
		writeFileSync(join(basePath, "memory", "memories.db"), "");

		const configureHarnessHooks = mock(async () => {});
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			configureHarnessHooks,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({
				...fakeDetection(basePath),
				agentYaml: true,
				memoryDb: true,
				harnesses: { ...NO_HARNESSES, forge: true, opencode: true },
			})),
			loadConfiguredHarnesses: mock(() => ["opencode"]),
		});

		await setupWizard({ nonInteractive: true, identityMode: "off", skipGit: true }, deps);

		// Connector cleanup should have been called for the detected harness
		expect(configureHarnessHooks).toHaveBeenCalled();
		const calls = configureHarnessHooks.mock.calls.map((c: unknown[]) => c[0]);
		expect(calls).toContain("opencode");
		expect(calls).toContain("forge");

		// agent.yaml should now have identity mode off
		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("mode: off");
	});
});
