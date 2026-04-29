import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SetupDetection, detectExistingSetup } from "@signet/core";
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

const ORIGINAL_HOME = process.env.HOME;

function freshDetection(basePath = "/tmp/agents"): SetupDetection {
	return {
		basePath,
		agentsDir: false,
		agentYaml: false,
		agentsMd: false,
		configYaml: false,
		memoryDb: false,
		identityFiles: [],
		hasMemoryDir: false,
		memoryLogCount: 0,
		hasClawdhub: false,
		hasClaudeSkills: false,
		harnesses: { ...NO_HARNESSES },
	};
}

function existingDetection(basePath = "/tmp/agents"): SetupDetection {
	return {
		basePath,
		agentsDir: true,
		agentYaml: true,
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
		detectExistingSetup: mock(() => freshDetection()),
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
		syncNativeEmbeddingModel: mock(async () => ({
			status: "current" as const,
			message: "nomic-ai/nomic-embed-text-v1.5",
		})),
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

describe("fresh setup native embedding model validation", () => {
	let root: string;

	afterEach(() => {
		if (ORIGINAL_HOME === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined"
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("calls syncNativeEmbeddingModel during fresh setup with native provider", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-native-validation-"));
		const basePath = join(root, "agents");

		const syncNativeEmbeddingModel = mock(async () => ({
			status: "current" as const,
			message: "nomic-ai/nomic-embed-text-v1.5",
		}));

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection(basePath)),
			syncNativeEmbeddingModel,
		});

		await setupWizard({ nonInteractive: true, embeddingProvider: "native" }, deps);

		expect(syncNativeEmbeddingModel.mock.calls.length).toBeGreaterThanOrEqual(1);
	});

	it("logs warning when native model warmup fails during fresh setup", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-native-fail-"));
		const basePath = join(root, "agents");

		const syncNativeEmbeddingModel = mock(async () => ({
			status: "error" as const,
			message: "warmup failed (model download timed out)",
		}));

		const logCalls: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			logCalls.push(args.join(" "));
		};

		try {
			const deps = stubDeps({
				AGENTS_DIR: basePath,
				normalizeAgentPath: mock((p: string) => p),
				detectExistingSetup: mock(() => freshDetection(basePath)),
				syncNativeEmbeddingModel,
			});

			await setupWizard({ nonInteractive: true, embeddingProvider: "native" }, deps);

			const output = logCalls.join("\n");
			expect(output).toContain("warmup failed");
		} finally {
			console.log = originalLog;
		}
	});

	it("does not call syncNativeEmbeddingModel when provider is not native", async () => {
		root = mkdtempSync(join(tmpdir(), "setup-non-native-"));
		const basePath = join(root, "agents");

		const syncNativeEmbeddingModel = mock(async () => ({
			status: "skipped" as const,
			message: "should not be called",
		}));

		const deps = stubDeps({
			AGENTS_DIR: basePath,
			normalizeAgentPath: mock((p: string) => p),
			detectExistingSetup: mock(() => freshDetection(basePath)),
			syncNativeEmbeddingModel,
		});

		await setupWizard({ nonInteractive: true, embeddingProvider: "none" }, deps);

		expect(syncNativeEmbeddingModel.mock.calls.length).toBe(0);
	});
});
