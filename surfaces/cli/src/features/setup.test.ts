import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as prompts from "@inquirer/prompts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNET_SECRETS_PLUGIN_ID, parseSimpleYaml, readGraphiqState, updateGraphiqActiveProject } from "@signet/core";
import { detectExistingSetup, type SetupDetection } from "../lib/setup-detection.js";
import { defaultBackupRoot, getSnapshotProtection } from "../lib/workspace-protection.js";
import * as openUrl from "../lib/open-url.js";
import { detectedHarnessesForExistingSetup, runExistingSetupWizard } from "./setup-migrate.js";
import { readSetupCorePluginEnabled } from "./setup-plugins.js";
import { runDashboardSetupBootstrap } from "./setup-fresh.js";
import type { SetupDeps } from "./setup-types.js";
import { setupWizard } from "./setup.js";

const NO_HARNESSES = {
	claudeCode: false,
	openclaw: false,
	opencode: false,
	forge: false,
	codex: false,
	kimi: false,
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
		signetBanner: mock(() => ""),
		startDaemon: mock(async () => true),
		getSkillsSourceDir: mock(() => "/tmp/skills"),
		syncBuiltinSkills: mock(() => ({ installed: [], updated: [], skipped: [] })),
		syncNativeEmbeddingModel: mock(async () => ({ status: "current" as const, message: "ready" })),
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
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
		if (ORIGINAL_HERMES_REPO === undefined) {
			delete process.env.HERMES_REPO;
		} else {
			process.env.HERMES_REPO = ORIGINAL_HERMES_REPO;
		}
		if (ORIGINAL_HERMES_HOME === undefined) {
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

	it("enables Dreaming for a fresh basic setup without an opt-in flag", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-fresh-dreaming-default-"));
		const basePath = join(root, "agents");
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({
				...fakeDetection(basePath),
				agentsDir: false,
				memoryDb: false,
			})),
		});

		await setupWizard({ nonInteractive: true, skipGit: true, identityMode: "off", extractionProvider: "none" }, deps);

		const config = parseSimpleYaml(readFileSync(join(basePath, "agent.yaml"), "utf-8"));
		const memory = config.memory as Record<string, unknown>;
		const dreaming = memory.dreaming as Record<string, unknown>;
		expect(dreaming.enabled).toBe(true);
	});

	it("enables Dreaming on an existing installation when requested", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-existing-dreaming-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		writeFileSync(
			join(basePath, "agent.yaml"),
			`version: 1
memory:
  pipelineV2:
    enabled: false
    semanticContradictionEnabled: false
    custom: keep
    graph:
      enabled: false
    reranker:
      enabled: false
    autonomous:
      enabled: false
      allowUpdateDelete: false
  dreaming:
    backfillOnFirstRun: true
`,
		);
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({ ...fakeDetection(basePath), agentYaml: true })),
		});

		await setupWizard(
			{
				nonInteractive: true,
				enableDreaming: true,
				skipGit: true,
				allowUnprotectedWorkspace: true,
			},
			deps,
		);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		const config = parseSimpleYaml(agentYaml);
		const memory = config.memory as Record<string, unknown>;
		const dreaming = memory.dreaming as Record<string, unknown>;
		const pipeline = memory.pipelineV2 as Record<string, unknown>;
		expect(dreaming.enabled).toBe(true);
		expect(dreaming.backfillOnFirstRun).toBe(true);
		expect(pipeline.enabled).toBe(true);
		expect(pipeline.semanticContradictionEnabled).toBe(false);
		expect(pipeline.custom).toBe("keep");
		expect((pipeline.graph as Record<string, unknown>).enabled).toBe(false);
		expect((pipeline.reranker as Record<string, unknown>).enabled).toBe(false);
		expect((pipeline.autonomous as Record<string, unknown>).enabled).toBe(false);
		expect((pipeline.autonomous as Record<string, unknown>).allowUpdateDelete).toBe(false);
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
		expect(agentYaml).toContain("executor: openai-compatible");
		expect(agentYaml).toContain("model: openai/gpt-oss-20b");
		expect(agentYaml).toContain("endpoint: https://gateway.example.test/v1");
		expect(agentYaml).toContain("memoryExtraction:");
		expect(agentYaml).not.toContain("provider: openai-compatible");
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

	it("creates a v2 workspace when migrating an identity-only directory", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-identity-v2-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		writeIdentityTemplates(templatesPath);
		writeFileSync(join(basePath, "IDENTITY.md"), "# Existing Agent\n");
		writeFileSync(join(basePath, "AGENTS.md"), "# Existing instructions\n");

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});

		await runExistingSetupWizard(basePath, { ...fakeDetection(basePath), memoryDb: false }, {}, deps, {
			nonInteractive: true,
			skipGit: true,
			allowUnprotectedWorkspace: true,
		});

		expect(JSON.parse(readFileSync(join(basePath, "workspace-layout.json"), "utf-8")).version).toBe(2);
		expect(existsSync(join(basePath, "data", "signet.db"))).toBe(true);
		expect(existsSync(join(basePath, "runtime", "plugins", "registry-v1.json"))).toBe(true);
		expect(existsSync(join(basePath, "memory"))).toBe(false);
		expect(existsSync(join(basePath, ".daemon"))).toBe(false);
		expect(readFileSync(join(basePath, "agent.yaml"), "utf-8")).toContain("database: data/signet.db");
	});

	it("keeps transcript-only v1 memory on the existing-workspace setup path", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-v1-transcripts-"));
		process.env.HOME = root;
		process.env.HERMES_HOME = join(root, ".hermes");
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		const transcripts = join(basePath, "memory", "codex", "transcripts");
		const transcript = '{"role":"user","content":"keep this conversation"}\n';
		mkdirSync(transcripts, { recursive: true });
		writeIdentityTemplates(templatesPath);
		writeFileSync(join(transcripts, "transcript.jsonl"), transcript);
		const detection = { ...fakeDetection(basePath), memoryDb: false, hasMemoryDir: true };

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			detectExistingSetup: mock(() => detection),
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});

		await setupWizard({ path: basePath, nonInteractive: true, skipGit: true, allowUnprotectedWorkspace: true }, deps);

		expect(existsSync(join(basePath, "workspace-layout.json"))).toBe(false);
		expect(readFileSync(join(transcripts, "transcript.jsonl"), "utf-8")).toBe(transcript);
		expect(readFileSync(join(basePath, "agent.yaml"), "utf-8")).toContain("database: memory/memories.db");
	});

	it("keeps an existing v1 database layout when migrating", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-v1-db-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(join(basePath, "memory"), { recursive: true });
		writeIdentityTemplates(templatesPath);
		writeFileSync(join(basePath, "memory", "memories.db"), "");

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});

		await runExistingSetupWizard(basePath, fakeDetection(basePath), {}, deps, {
			nonInteractive: true,
			skipGit: true,
			allowUnprotectedWorkspace: true,
		});

		expect(existsSync(join(basePath, "workspace-layout.json"))).toBe(false);
		expect(existsSync(join(basePath, "data"))).toBe(false);
		expect(existsSync(join(basePath, "memory", "scripts"))).toBe(false);
	});

	it("enables Dreaming defaults and removes retired routing during existing setup", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-dreaming-defaults-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
		writeIdentityTemplates(templatesPath);
		writeFileSync(join(basePath, "agent.yaml"), "version: 1\n");

		const existingConfig = {
			memory: {
				dreaming: { enabled: true },
				synthesis: { harness: "openclaw" },
				pipelineV2: {
					enabled: false,
					writeGate: { threshold: 0.4 },
					durability: "transient",
					extraction: { provider: "claude-code", model: "haiku" },
					graph: { enabled: false },
					reranker: { enabled: false },
					autonomous: { enabled: false, allowUpdateDelete: false, maintenanceMode: "observe" },
				},
			},
		};
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});

		await runExistingSetupWizard(basePath, fakeDetection(basePath), existingConfig, deps, {
			nonInteractive: true,
			skipGit: true,
			allowUnprotectedWorkspace: true,
			extractionProvider: "none",
			signetSecretsEnabled: true,
		});

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("dreaming:\n    enabled: true");
		expect(agentYaml).toContain("pipelineV2:\n    enabled: true");
		expect(agentYaml).toContain("graph:\n      enabled: true");
		expect(agentYaml).toContain("reranker:\n      enabled: true");
		expect(agentYaml).toContain("allowUpdateDelete: true");
		expect(agentYaml).toContain("maintenanceMode: execute");
		expect(agentYaml).toContain("rehearsal_enabled: true");
		expect(agentYaml).not.toContain("synthesis:");
		expect(agentYaml).not.toContain("writeGate:");
		expect(agentYaml).not.toContain("durability:");
		expect(agentYaml).not.toContain("provider: claude-code");
		expect(agentYaml).not.toContain("model: haiku");
	});

	it("removes retired pipeline settings from existing setup even when Dreaming is off", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-retired-settings-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
		writeIdentityTemplates(templatesPath);
		writeFileSync(join(basePath, "agent.yaml"), "version: 1\n");

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});
		await runExistingSetupWizard(
			basePath,
			fakeDetection(basePath),
			{
				memory: {
					synthesis: { harness: "openclaw" },
					pipelineV2: {
						extractionProvider: "claude-code",
						extraction: { provider: "claude-code", model: "legacy-model" },
						writeGate: { threshold: 0.4 },
					},
				},
			},
			deps,
			{
				nonInteractive: true,
				skipGit: true,
				allowUnprotectedWorkspace: true,
				signetSecretsEnabled: true,
			},
		);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).not.toContain("synthesis:");
		expect(agentYaml).not.toContain("pipelineV2:");
		expect(agentYaml).not.toContain("claude-code");
		expect(agentYaml).not.toContain("legacy-model");
	});

	it("does not carry retired fields into a new manifest when existing setup lacks agent.yaml", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-new-manifest-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
		writeIdentityTemplates(templatesPath);

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});
		await runExistingSetupWizard(
			basePath,
			fakeDetection(basePath),
			{
				memory: {
					synthesis: { harness: "openclaw" },
					pipelineV2: { extractionProvider: "claude-code", writeGate: { threshold: 0.4 } },
				},
			},
			deps,
			{
				nonInteractive: true,
				skipGit: true,
				allowUnprotectedWorkspace: true,
				signetSecretsEnabled: true,
			},
		);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).not.toContain("synthesis:");
		expect(agentYaml).not.toContain("pipelineV2:");
		expect(agentYaml).not.toContain("claude-code");
	});

	it("applies an explicit extraction provider to an existing manifest", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-extraction-provider-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
		writeIdentityTemplates(templatesPath);
		writeFileSync(join(basePath, "agent.yaml"), "version: 1\n");

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
		});
		await runExistingSetupWizard(basePath, fakeDetection(basePath), {}, deps, {
			nonInteractive: true,
			skipGit: true,
			allowUnprotectedWorkspace: true,
			extractionProvider: "ollama",
			extractionModel: "qwen3:4b",
			signetSecretsEnabled: true,
		});

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("executor: ollama");
		expect(agentYaml).toContain("model: qwen3:4b");
	});

	it("includes Hermes in migration harnesses when detected in ~/.hermes", () => {
		root = mkdtempSync(join(tmpdir(), "setup-migrate-hermes-default-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(root, ".hermes", "plugins", "memory"), { recursive: true });
		process.env.HOME = root;
		delete process.env.HERMES_REPO;
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

	it("persists disabled embeddings so a fresh install does not silently load the native model", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-no-embeddings-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({
				...fakeDetection(basePath),
				agentsDir: false,
				memoryDb: false,
			})),
		});

		await setupWizard({ nonInteractive: true, embeddingProvider: "none", skipGit: true }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("embedding:\n  provider: none");
	});

	it("leaves telemetry off until the user opts in", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-telemetry-"));
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

		await setupWizard({ nonInteractive: true, skipGit: true }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml.indexOf("memory:")).toBeGreaterThanOrEqual(0);
		expect(agentYaml.indexOf("telemetryEnabled: false")).toBeGreaterThan(agentYaml.indexOf("memory:"));
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
		expect(existsSync(join(basePath, "data", "signet.db"))).toBe(true);
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
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain(
				"Unknown --identity-mode value: ghost",
			);
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
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain(
				"Unknown --identity-preset value: maximalist",
			);
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
		for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
			expect(existsSync(join(basePath, name))).toBe(true);
		}
		const agentsContent = readFileSync(join(basePath, "AGENTS.md"), "utf-8");
		expect(agentsContent).toContain("Agent Instructions");
		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("mode: managed");
	});

	it("runs connector cleanup when switching from managed to off", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-ni-managed-to-off-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(join(basePath, "memory"), { recursive: true });
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
		expect(configureHarnessHooks).toHaveBeenCalled();
		const calls = configureHarnessHooks.mock.calls.map((c: unknown[]) => c[0]);
		expect(calls).toContain("opencode");
		expect(calls).toContain("forge");
		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("mode: off");
	});

	it("prints the setup plan JSON Schema and exits before any wizard work when --schema is set", async () => {
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			const signetLogo = mock(() => "SHOULD-NOT-APPEAR");
			const detectExistingSetup = mock(() => fakeDetection());
			const deps = stubDeps({ signetLogo, detectExistingSetup });

			await setupWizard({ schema: true }, deps);
			const printed = logSpy.mock.calls[0]?.[0] as string;
			const parsed = JSON.parse(printed);
			expect(parsed.$schema).toContain("json-schema.org");
			expect(parsed.properties.agentName).toBeDefined();
			expect(parsed.properties.networkMode.enum).toEqual(["localhost", "tailscale"]);
			expect(signetLogo).not.toHaveBeenCalled();
			expect(detectExistingSetup).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("setupWizard headless plan path", () => {
	let root: string;

	function writePlanFile(dir: string, overrides: Record<string, unknown> = {}): string {
		const planPath = join(dir, "plan.json");
		const plan = {
			agentName: "Headless Agent",
			agentDescription: "From a plan file",
			networkMode: "localhost",
			harnesses: ["claude-code"],
			openclawRuntimePath: "plugin",
			configureOpenClawWs: false,
			embeddingProvider: "native",
			embeddingModel: "nomic-embed-text-v1.5",
			embeddingDimensions: 768,
			extractionProvider: "none",
			extractionModel: "",
			searchBalance: 0.7,
			searchTopK: 20,
			searchMinScore: 0.3,
			memorySessionBudget: 2000,
			memoryDecayRate: 0.95,
			gitEnabled: false,
			signetSecretsEnabled: true,
			graphiqEnabled: false,
			identityMode: "managed",
			identityPreset: "minimal",
			startupIdentityFiles: [{ path: "AGENTS.md" }],
			specialIdentityFiles: [{ path: "DREAMING.md", kind: "dreaming" }],
			...overrides,
		};
		writeFileSync(planPath, JSON.stringify(plan));
		return planPath;
	}

	function freshDeps(basePath: string, templatesPath: string): SetupDeps {
		const freshDetection: SetupDetection = { ...fakeDetection(basePath), agentsDir: false, memoryDb: false };
		return stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection),
		});
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("applies a plan from --file without prompts", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-file-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root);
		const deps = freshDeps(basePath, templatesPath);

		await setupWizard({ file: planPath }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("name: Headless Agent");
		expect(agentYaml).toContain("mode: localhost");
		expect(existsSync(join(basePath, "data", "signet.db"))).toBe(true);
		const config = parseSimpleYaml(agentYaml);
		const memory = config.memory as Record<string, unknown>;
		expect((memory.dreaming as Record<string, unknown>).enabled).toBe(true);
	});

	it("rejects a malformed --agent flag instead of silently dropping it", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-badagent-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({ ...fakeDetection(basePath), agentsDir: false, memoryDb: false })),
		});

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ nonInteractive: true, agent: ["researcher"] }, deps)).rejects.toThrow(
				"process.exit:1",
			);
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("Expected name:policy");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("runs flag-path plans through parseSetupPlan (aggregate-recall model without provider)", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-flag-aggrecall-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({ ...fakeDetection(basePath), agentsDir: false, memoryDb: false })),
		});

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ nonInteractive: true, aggregateRecallModel: "x" }, deps)).rejects.toThrow(
				"process.exit:1",
			);
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("aggregateRecallProvider");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("connects an obsidian vault source from a plan file", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-obsidian-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		const vaultPath = join(root, "vault");
		writeIdentityTemplates(templatesPath);
		mkdirSync(vaultPath, { recursive: true });
		writeFileSync(join(vaultPath, "note.md"), "# note");
		const planPath = writePlanFile(root, { sources: [{ type: "obsidian", path: vaultPath, name: "my-vault" }] });
		const deps = freshDeps(basePath, templatesPath);

		await setupWizard({ file: planPath }, deps);

		const sourcesConfig = readFileSync(join(basePath, "sources.json"), "utf-8");
		expect(sourcesConfig).toContain("my-vault");
		expect(sourcesConfig).toContain(vaultPath);
	});

	it("writes a remote daemon URL and skips local daemon start", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-remote-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, { daemonUrl: "https://signet.remote.example:8443" });
		const startDaemon = mock(async () => true);
		const deps = { ...freshDeps(basePath, templatesPath), startDaemon };

		await setupWizard({ file: planPath }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("url: https://signet.remote.example:8443");
		expect(startDaemon).not.toHaveBeenCalled();
	});

	it("rejects a remote daemon URL with a path before building a setup plan", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-remote-url-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => ({ ...fakeDetection(basePath), agentsDir: false, memoryDb: false })),
		});
		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				setupWizard({ nonInteractive: true, remoteUrl: "https://signet.remote.example/api" }, deps),
			).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain(
				"bare http:// or https:// origin",
			);
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("writes a multi-agent roster from a plan file", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-roster-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, {
			agents: [
				{ name: "researcher", memoryPolicy: "isolated" },
				{ name: "writer", memoryPolicy: "group", memoryGroup: "docs" },
			],
		});
		const deps = freshDeps(basePath, templatesPath);

		await setupWizard({ file: planPath }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("roster:");
		expect(agentYaml).toContain("name: researcher");
		expect(agentYaml).toContain("name: writer");
		expect(agentYaml).toContain("group: docs");
	});

	it("enables dreaming when the plan sets dreamingEnabled", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-dreaming-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, { dreamingEnabled: true });
		const deps = freshDeps(basePath, templatesPath);

		await setupWizard({ file: planPath }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("dreaming:");
		expect(agentYaml).toContain("enabled: true");
		expect(agentYaml).toContain("rehearsal_enabled: true");
		expect(agentYaml).toContain("pipelineV2:\n    enabled: true");
		expect(agentYaml).toContain("graph:\n      enabled: true");
		expect(agentYaml).toContain("reranker:\n      enabled: true");
		expect(agentYaml).toContain("allowUpdateDelete: true");
		expect(agentYaml).toContain("maintenanceMode: execute");
		expect(agentYaml).not.toContain("synthesis:");
		expect(agentYaml).not.toContain("provider: claude-code");
	});

	it("keeps Dreaming off when a fresh setup plan explicitly disables it", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-dreaming-disabled-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, { dreamingEnabled: false });
		const deps = freshDeps(basePath, templatesPath);

		await setupWizard({ file: planPath }, deps);

		const config = parseSimpleYaml(readFileSync(join(basePath, "agent.yaml"), "utf-8"));
		const memory = config.memory as Record<string, unknown>;
		expect(memory.dreaming).toBeUndefined();
		expect((memory.pipelineV2 as Record<string, unknown>).enabled).toBe(false);
	});

	it("rejects a connected cloud extraction target from a headless plan", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-connect-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, {
			extractionProvider: "openrouter",
			extractionModel: "anthropic/claude-3.5-haiku",
			extractionConnect: { family: "openrouter", connectMethod: "api" },
		});
		const deps = freshDeps(basePath, templatesPath);

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ file: planPath }, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("extractionConnect");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("rejects a non-legacy connected provider from a headless plan", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-connect-anthropic-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, {
			extractionProvider: "anthropic",
			extractionModel: "claude-3-5-haiku-20241022",
			extractionConnect: { family: "anthropic", connectMethod: "oauth" },
		});
		const deps = freshDeps(basePath, templatesPath);

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ file: planPath }, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("extractionConnect");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("writes a distinct aggregate-recall target from a plan file", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-aggrecall-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, {
			extractionProvider: "claude-code",
			extractionModel: "haiku",
			aggregateRecallProvider: "openrouter",
			aggregateRecallModel: "anthropic/claude-3.5-sonnet",
		});
		const deps = freshDeps(basePath, templatesPath);

		await setupWizard({ file: planPath }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("aggregateRecall:");
		expect(agentYaml).toContain("target: aggregation/default");
		expect(agentYaml).toContain("anthropic/claude-3.5-sonnet");
		expect(agentYaml).toContain("credentialRef: OPENROUTER_API_KEY");
	});

	it("applies a plan from an inline --json string", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-json-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const deps = freshDeps(basePath, templatesPath);
		const planJson = JSON.stringify({
			agentName: "Inline Agent",
			agentDescription: "d",
			networkMode: "localhost",
			harnesses: [],
			openclawRuntimePath: "plugin",
			configureOpenClawWs: false,
			embeddingProvider: "none",
			embeddingModel: "",
			embeddingDimensions: 768,
			extractionProvider: "none",
			extractionModel: "",
			searchBalance: 0.7,
			searchTopK: 20,
			searchMinScore: 0.3,
			memorySessionBudget: 2000,
			memoryDecayRate: 0.95,
			gitEnabled: false,
			signetSecretsEnabled: false,
			graphiqEnabled: false,
			identityMode: "off",
			identityPreset: "minimal",
			startupIdentityFiles: [],
			specialIdentityFiles: [],
		});

		await setupWizard({ json: planJson }, deps);

		const agentYaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
		expect(agentYaml).toContain("name: Inline Agent");
		expect(agentYaml).toContain("mode: off");
	});

	it("--dry-run prints the plan and applies nothing", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-dryrun-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root, { agentName: "Dry Run Agent" });
		const deps = freshDeps(basePath, templatesPath);

		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			await setupWizard({ file: planPath, dryRun: true }, deps);

			const printed = logSpy.mock.calls[0]?.[0] as string;
			const parsed = JSON.parse(printed);
			expect(parsed.agentName).toBe("Dry Run Agent");
			expect(existsSync(join(basePath, "agent.yaml"))).toBe(false);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rejects an invalid plan JSON with a structured error", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-bad-"));
		const basePath = join(root, "agents");
		const badPath = join(root, "bad.json");
		writeFileSync(badPath, "{not valid json");
		const deps = freshDeps(basePath, root);

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ file: badPath }, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("not valid JSON");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refuses to overwrite an existing installation", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-existing-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		writeIdentityTemplates(templatesPath);
		const planPath = writePlanFile(root);
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			getTemplatesDir: mock(() => templatesPath),
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => fakeDetection(basePath)),
		});

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ file: planPath }, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain(
				"existing Signet installation",
			);
			expect(existsSync(join(basePath, "agent.yaml"))).toBe(false);
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("rejects a plan that fails validation", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-headless-invalid-"));
		const basePath = join(root, "agents");
		const planPath = writePlanFile(root, { searchBalance: 5 });
		const deps = freshDeps(basePath, root);

		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({ file: planPath }, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("searchBalance");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("fails closed when invoked interactively without a TTY", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-notty-"));
		const basePath = join(root, "agents");
		mkdirSync(basePath, { recursive: true });
		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => fakeDetection(basePath)),
		});

		const originalTty = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(setupWizard({}, deps)).rejects.toThrow("process.exit:1");
			expect(errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")).toContain("requires a TTY");
		} finally {
			exitSpy.mockRestore();
			errorSpy.mockRestore();
			Object.defineProperty(process.stdin, "isTTY", { value: originalTty, configurable: true });
		}
	});
});

describe("interactive onboarding", () => {
	let previousPort: string | undefined;
	let previousDaemonUrl: string | undefined;

	beforeEach(() => {
		previousPort = process.env.SIGNET_PORT;
		previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		Reflect.deleteProperty(process.env, "SIGNET_PORT");
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
	});

	afterEach(() => {
		if (previousPort === undefined) Reflect.deleteProperty(process.env, "SIGNET_PORT");
		else process.env.SIGNET_PORT = previousPort;
		if (previousDaemonUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
	});

	it("routes transcript-only v1 workspaces through existing interactive setup", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-onboarding-transcript-only-"));
		const transcriptDir = join(root, "memory", "codex", "transcripts");
		mkdirSync(transcriptDir, { recursive: true });
		const transcript = '{"role":"user","content":"keep this conversation"}\n';
		writeFileSync(join(transcriptDir, "transcript.jsonl"), transcript);
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ agentsDir: root }) });
		process.env.SIGNET_PORT = String(server.port);
		const confirm = spyOn(prompts, "confirm").mockImplementation(() =>
			Object.assign(Promise.resolve(false), { cancel: () => {} }),
		);
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousTty = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: root,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({ ...fakeDetection(root), memoryDb: false, hasMemoryDir: true }),
			});
			await setupWizard({}, deps);

			expect(existsSync(join(root, "workspace-layout.json"))).toBe(false);
			expect(readFileSync(join(root, "agent.yaml"), "utf8")).toContain("database: memory/memories.db");
			expect(readFileSync(join(transcriptDir, "transcript.jsonl"), "utf8")).toBe(transcript);
			expect(open).not.toHaveBeenCalled();
		} finally {
			confirm.mockRestore();
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resumes through the dashboard without rewriting the workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-onboarding-"));
		const config = "name: Existing agent\noperator_setting: preserve-me\n";
		writeFileSync(join(root, "agent.yaml"), config);
		writeFileSync(join(root, "AGENTS.md"), "User-authored instructions");
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ agentsDir: root }) });
		process.env.SIGNET_PORT = String(server.port);
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousTty = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: root,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({ ...fakeDetection(root), agentYaml: true }),
			});
			await setupWizard({}, deps);
			expect(open).toHaveBeenCalledWith(`http://127.0.0.1:${server.port}/#setup`);
			expect(readFileSync(join(root, "agent.yaml"), "utf8")).toBe(config);
			expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("User-authored instructions");
			expect(deps.configureHarnessHooks).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not open onboarding for an unavailable or different workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-onboarding-failure-"));
		writeFileSync(join(root, "agent.yaml"), "name: Keep me\n");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: "/another/workspace" }),
		});
		process.env.SIGNET_PORT = String(server.port);
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousTty = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: root,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({ ...fakeDetection(root), agentYaml: true }),
			});
			await expect(setupWizard({}, { ...deps, startDaemon: async () => false })).rejects.toThrow(
				"Could not start Signet",
			);
			await expect(setupWizard({}, deps)).rejects.toThrow("Another workspace");
			expect(open).not.toHaveBeenCalled();
			expect(readFileSync(join(root, "agent.yaml"), "utf8")).toBe("name: Keep me\n");
		} finally {
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("first-run setup migration onboarding handoff", () => {
	let root = "";
	let previousPort: string | undefined;
	let previousDaemonUrl: string | undefined;

	beforeEach(() => {
		previousPort = process.env.SIGNET_PORT;
		previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		Reflect.deleteProperty(process.env, "SIGNET_PORT");
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
	});

	afterEach(() => {
		if (previousPort === undefined) Reflect.deleteProperty(process.env, "SIGNET_PORT");
		else process.env.SIGNET_PORT = previousPort;
		if (previousDaemonUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("opens the guided setup flow after the user accepts the dashboard prompt", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-first-run-onboarding-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(templatesPath, { recursive: true });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: basePath }),
		});
		process.env.SIGNET_PORT = String(server.port);

		const confirm = spyOn(prompts, "confirm").mockImplementation(() =>
			Object.assign(Promise.resolve(true), { cancel: () => {} }),
		);
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousTty = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				DEFAULT_PORT: 4217,
				getTemplatesDir: mock(() => templatesPath),
				normalizeAgentPath: mock((path: string) => path),
				detectExistingSetup: mock(() => ({
					...fakeDetection(basePath),
					agentYaml: false,
					configYaml: false,
					memoryDb: true,
				})),
			});

			await setupWizard({}, deps);

			expect(confirm).toHaveBeenCalledWith({ message: "Open the dashboard?", default: true });
			expect(open).toHaveBeenCalledWith(`http://127.0.0.1:${server.port}/#setup`);
		} finally {
			confirm.mockRestore();
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
		}
	});

	it("refuses to open onboarding when the local daemon serves a different workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-first-run-onboarding-scope-"));
		const basePath = join(root, "agents");
		const templatesPath = join(root, "templates");
		mkdirSync(basePath, { recursive: true });
		mkdirSync(templatesPath, { recursive: true });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: join(root, "other-agents") }),
		});
		process.env.SIGNET_PORT = String(server.port);
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const exit = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			throw new Error(`process.exit:${code ?? ""}`);
		}) as never);
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			console.error("Unrelated logger diagnostic before workspace refusal");
			await expect(
				runExistingSetupWizard(
					basePath,
					fakeDetection(basePath),
					{},
					stubDeps({
						AGENTS_DIR: basePath,
						DEFAULT_PORT: 4217,
						getTemplatesDir: mock(() => templatesPath),
						normalizeAgentPath: mock((path: string) => path),
					}),
					{
						nonInteractive: true,
						openDashboard: true,
						skipGit: true,
						allowUnprotectedWorkspace: true,
					},
				),
			).rejects.toThrow("process.exit:1");
			expect(error.mock.calls.some((call) => String(call[0] ?? "").includes("Another workspace"))).toBe(true);
			expect(open).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			exit.mockRestore();
			error.mockRestore();
			server.stop(true);
		}
	});
});

describe("fresh interactive dashboard setup", () => {
	let root = "";

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("refuses a legacy database created during workspace protection", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-raced-v1-"));
		const basePath = join(root, "agents");
		const legacyDatabase = join(basePath, "memory", "memories.db");
		const configPath = join(root, "openclaw.json");
		writeFileSync(configPath, "{}\n");
		const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
		process.env.OPENCLAW_CONFIG_PATH = configPath;
		try {
			const bootstrap = runDashboardSetupBootstrap(
				basePath,
				{ allowUnprotectedWorkspace: false, createLocalBackup: false },
				stubDeps(),
			);
			mkdirSync(join(basePath, "memory"), { recursive: true });
			writeFileSync(legacyDatabase, "concurrent-v1-database");

			await expect(bootstrap).rejects.toThrow(`Refusing to replace an existing database at ${legacyDatabase}.`);

			expect(readFileSync(legacyDatabase, "utf8")).toBe("concurrent-v1-database");
			expect(existsSync(join(basePath, "workspace-layout.json"))).toBe(false);
			expect(existsSync(join(basePath, "data", "signet.db"))).toBe(false);
		} finally {
			if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
			else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
		}
	});

	it("refuses a database at the next layout path under a custom data override", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-custom-data-v1-"));
		const basePath = join(root, "agents");
		const layoutFile = join(basePath, "workspace-layout.json");
		const layoutContent = `${JSON.stringify({ version: 1, overrides: { data: "custom-data" } }, null, 2)}\n`;
		const databasePath = join(basePath, "custom-data", "signet.db");
		const configPath = join(root, "openclaw.json");
		mkdirSync(join(basePath, "custom-data"), { recursive: true });
		writeFileSync(layoutFile, layoutContent);
		writeFileSync(databasePath, "existing-custom-v2-database");
		writeFileSync(configPath, "{}\n");
		const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
		process.env.OPENCLAW_CONFIG_PATH = configPath;
		try {
			await expect(
				runDashboardSetupBootstrap(
					basePath,
					{ allowUnprotectedWorkspace: false, createLocalBackup: false },
					stubDeps(),
				),
			).rejects.toThrow(`Refusing to replace an existing database at ${databasePath}.`);

			expect(readFileSync(databasePath, "utf8")).toBe("existing-custom-v2-database");
			expect(readFileSync(layoutFile, "utf8")).toBe(layoutContent);
			expect(existsSync(join(basePath, "agent.yaml"))).toBe(false);
		} finally {
			if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
			else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
		}
	});

	it("creates only the dashboard bootstrap and opens onboarding", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-"));
		const basePath = join(root, "agents");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) =>
				new URL(request.url).pathname === "/api/status"
					? Response.json({ agentsDir: basePath })
					: new Response("not found", { status: 404 }),
		});
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		const previousTty = process.stdin.isTTY;
		delete process.env.SIGNET_DAEMON_URL;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				DEFAULT_PORT: server.port,
				getTemplatesDir: mock(() => join(import.meta.dir, "../../templates")),
				detectExistingSetup: () => ({
					...fakeDetection(basePath),
					agentsDir: false,
					agentYaml: false,
					configYaml: false,
					memoryDb: false,
					hasMemoryDir: false,
				}),
				normalizeAgentPath: mock((path: string) => path),
			});

			await setupWizard({ path: basePath }, deps);

			expect(deps.startDaemon).toHaveBeenCalledWith(basePath);
			const agentYaml = parseSimpleYaml(readFileSync(join(basePath, "agent.yaml"), "utf8"));
			expect(Object.keys(agentYaml).sort()).toEqual(["capabilities", "embedding", "memory", "schema", "version"]);
			expect(agentYaml.embedding).toEqual({ provider: "none" });
			expect(agentYaml.memory).toMatchObject({
				database: "data/signet.db",
				pipelineV2: { enabled: false, paused: true, telemetryEnabled: false },
			});
			expect(agentYaml.capabilities).toMatchObject({
				memory: { enabled: true },
				secrets: { enabled: true },
				identity: { mode: "off" },
			});
			expect(readSetupCorePluginEnabled(basePath)).toBe(true);
			expect(existsSync(join(basePath, "data", "signet.db"))).toBe(true);
			expect(readFileSync(join(basePath, ".gitignore"), "utf8")).toContain("# Signet workspace Git policy");
			expect(existsSync(join(basePath, "AGENTS.md"))).toBe(false);
			expect(existsSync(join(basePath, "scripts"))).toBe(false);
			expect(existsSync(join(basePath, "harnesses"))).toBe(false);
			expect(existsSync(join(basePath, ".git"))).toBe(false);
			expect(readdirSync(join(basePath, "skills"))).toEqual([]);
			expect(open).toHaveBeenCalledWith(`http://127.0.0.1:${server.port}/#setup`);
		} finally {
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			if (previousDaemonUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
			else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
		}
	});

	it("applies explicit fresh-setup options when Git is skipped", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-skip-git-"));
		const basePath = join(root, "agents");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: basePath }),
		});
		const previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		const previousTty = process.stdin.isTTY;
		delete process.env.SIGNET_DAEMON_URL;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const gitInit = mock(async () => true);
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({
					...fakeDetection(basePath),
					agentsDir: false,
					agentYaml: false,
					configYaml: false,
					memoryDb: false,
					hasMemoryDir: false,
				}),
				gitInit,
				normalizeAgentPath: mock((path: string) => path),
			});

			await setupWizard({ path: basePath, skipGit: true }, deps);

			const config = parseSimpleYaml(readFileSync(join(basePath, "agent.yaml"), "utf8"));
			expect(config.agent).toBeDefined();
			expect(gitInit).not.toHaveBeenCalled();
		} finally {
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			if (previousDaemonUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
			else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
		}
	});

	it("creates a valid local snapshot for an OpenClaw-linked fresh workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-snapshot-"));
		const workspaceName = `agents-dashboard-bootstrap-snapshot-${process.pid}-${Date.now()}`;
		const basePath = join(root, workspaceName);
		const configPath = join(root, "openclaw.json");
		const backupRoot = defaultBackupRoot(basePath);
		const previousSnapshots = new Set(existsSync(backupRoot) ? readdirSync(backupRoot) : []);
		writeFileSync(configPath, JSON.stringify({ agents: { defaults: { workspace: basePath } } }));
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: basePath }),
		});
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
		const previousHome = process.env.HOME;
		const previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		const previousTty = process.stdin.isTTY;
		process.env.OPENCLAW_CONFIG_PATH = configPath;
		process.env.HOME = root;
		delete process.env.SIGNET_DAEMON_URL;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				DEFAULT_PORT: server.port,
				getTemplatesDir: mock(() => join(import.meta.dir, "../../templates")),
				detectExistingSetup: () => ({
					...fakeDetection(basePath),
					agentsDir: false,
					agentYaml: false,
					configYaml: false,
					memoryDb: false,
					hasMemoryDir: false,
				}),
				normalizeAgentPath: mock((path: string) => path),
			});

			await setupWizard({ path: basePath, createLocalBackup: true }, deps);

			const snapshotPath = getSnapshotProtection(basePath);
			expect(snapshotPath).not.toBeNull();
			if (!snapshotPath) throw new Error("expected a protected workspace snapshot");
			expect(existsSync(join(snapshotPath, "agent.yaml"))).toBe(true);
			expect(existsSync(join(snapshotPath, "data", "signet.db"))).toBe(true);
			expect(existsSync(join(basePath, "AGENTS.md"))).toBe(false);
			expect(open).toHaveBeenCalledWith(`http://127.0.0.1:${server.port}/#setup`);
		} finally {
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
			else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousDaemonUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
			else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
			if (existsSync(backupRoot)) {
				for (const entry of readdirSync(backupRoot)) {
					if (entry.startsWith(`${workspaceName}-`) && !previousSnapshots.has(entry))
						rmSync(join(backupRoot, entry), { recursive: true, force: true });
				}
			}
		}
	});

	it("refuses an orphaned v2 database before writing workspace bootstrap files", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-orphan-v2-"));
		const basePath = join(root, "agents");
		const databasePath = join(basePath, "data", "signet.db");
		const configPath = join(root, "openclaw.json");
		mkdirSync(join(basePath, "data"), { recursive: true });
		writeFileSync(databasePath, "existing-v2-database");
		writeFileSync(configPath, "{}");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: basePath }),
		});
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
		const previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		const previousTty = process.stdin.isTTY;
		process.env.OPENCLAW_CONFIG_PATH = configPath;
		delete process.env.SIGNET_DAEMON_URL;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({
					...fakeDetection(basePath),
					agentsDir: true,
					agentYaml: false,
					configYaml: false,
					memoryDb: false,
					hasMemoryDir: true,
				}),
				normalizeAgentPath: mock((path: string) => path),
			});

			await expect(setupWizard({ path: basePath }, deps)).rejects.toThrow("Refusing to replace an existing database");

			expect(readFileSync(databasePath, "utf8")).toBe("existing-v2-database");
			expect(existsSync(join(basePath, "workspace-layout.json"))).toBe(false);
			expect(existsSync(join(basePath, ".gitignore"))).toBe(false);
			expect(open).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			if (previousConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
			else process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
			if (previousDaemonUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
			else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
		}
	});

	it("leaves the workspace untouched when another local workspace is serving", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-dashboard-bootstrap-other-workspace-"));
		const basePath = join(root, "agents");
		const runningWorkspace = join(root, "other-agents");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: runningWorkspace }),
		});
		const open = spyOn(openUrl, "openUrlWithFallback").mockResolvedValue(undefined);
		const previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
		const previousTty = process.stdin.isTTY;
		delete process.env.SIGNET_DAEMON_URL;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({
					...fakeDetection(basePath),
					agentsDir: false,
					agentYaml: false,
					configYaml: false,
					memoryDb: false,
					hasMemoryDir: false,
				}),
				normalizeAgentPath: mock((path: string) => path),
			});

			await expect(setupWizard({ path: basePath }, deps)).rejects.toThrow(
				"Another workspace is running at this address.",
			);

			expect(deps.startDaemon).not.toHaveBeenCalled();
			expect(existsSync(basePath)).toBe(false);

			const explicitBasePath = join(root, "agents-with-explicit-options");
			const explicitDeps = stubDeps({
				AGENTS_DIR: explicitBasePath,
				DEFAULT_PORT: server.port,
				detectExistingSetup: () => ({
					...fakeDetection(explicitBasePath),
					agentsDir: false,
					agentYaml: false,
					configYaml: false,
					memoryDb: false,
					hasMemoryDir: false,
				}),
				normalizeAgentPath: mock((path: string) => path),
			});
			await expect(setupWizard({ path: explicitBasePath, harness: ["pi"] }, explicitDeps)).rejects.toThrow(
				"Another workspace is running at this address.",
			);
			expect(explicitDeps.startDaemon).not.toHaveBeenCalled();
			expect(existsSync(explicitBasePath)).toBe(false);
			expect(open).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			server.stop(true);
			Object.defineProperty(process.stdin, "isTTY", { value: previousTty, configurable: true });
			if (previousDaemonUrl === undefined) delete process.env.SIGNET_DAEMON_URL;
			else process.env.SIGNET_DAEMON_URL = previousDaemonUrl;
		}
	});
});
