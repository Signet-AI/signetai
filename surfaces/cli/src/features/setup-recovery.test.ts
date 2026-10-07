import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistWorkspaceLayout } from "@signet/core";
import Database from "../sqlite.js";
import type { SetupDeps } from "./setup-types.js";

const realInquirerPrompts = { ...(await import("@inquirer/prompts")) };
afterAll(() => {
	mock.module("@inquirer/prompts", () => realInquirerPrompts);
});
mock.module("@inquirer/prompts", () => ({
	confirm: async () => false,
	input: async () => "",
	select: async () => "bypass",
}));

const { setupWizard } = await import("./setup.js");
const originalTty = process.stdin.isTTY;
let root = "";

afterEach(() => {
	Object.defineProperty(process.stdin, "isTTY", { value: originalTty, configurable: true });
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("setup recovery", () => {
	it("creates a missing manifest while preserving the database in either workspace layout", async () => {
		root = mkdtempSync(join(tmpdir(), "signet-setup-recovery-"));
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

		for (const layoutVersion of [1, 2] as const) {
			const basePath = join(root, `workspace-v${layoutVersion}`);
			mkdirSync(basePath, { recursive: true });
			if (layoutVersion === 2) persistWorkspaceLayout(basePath, { version: 2 });
			const dbPath =
				layoutVersion === 1 ? join(basePath, "memory", "memories.db") : join(basePath, "data", "signet.db");
			mkdirSync(join(dbPath, ".."), { recursive: true });
			const db = Database(dbPath);
			db.exec("CREATE TABLE recovery_marker (value TEXT NOT NULL)");
			db.prepare("INSERT INTO recovery_marker VALUES (?)").run("preserve-me");
			db.close();

			const startDaemon = mock(async () => false);
			const detection = {
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
				harnesses: {
					claudeCode: false,
					openclaw: false,
					opencode: false,
					forge: false,
					codex: false,
					kimi: false,
					museCode: false,
					ohMyPi: false,
					pi: false,
					hermesAgent: false,
					gemini: false,
				},
			};
			const deps: SetupDeps = {
				AGENTS_DIR: basePath,
				DEFAULT_PORT: 4100,
				configureHarnessHooks: async () => {},
				copyDirRecursive: () => {},
				detectExistingSetup: () => detection,
				getSkillsSourceDir: () => join(root, "skills"),
				getTemplatesDir: () => join(root, "templates"),
				gitAddAndCommit: async () => false,
				gitInit: async () => false,
				importFromGitHub: async () => {},
				isDaemonRunning: async () => false,
				isGitRepo: () => true,
				launchDashboard: async () => {},
				normalizeAgentPath: (path) => path,
				normalizeChoice: <T extends string>(value: unknown, allowed: readonly T[]) => {
					const normalized = String(value);
					return allowed.includes(normalized as T) ? (normalized as T) : null;
				},
				normalizeStringValue: (value) => (typeof value === "string" ? value : null),
				parseIntegerValue: () => null,
				parseSearchBalanceValue: () => null,
				showStatus: async () => {},
				signetLogo: () => "",
				signetBanner: () => "",
				startDaemon,
				syncBuiltinSkills: () => ({ installed: [], updated: [], skipped: [] }),
				syncNativeEmbeddingModel: async () => ({ status: "current", message: "ready" }),
			};

			await setupWizard({}, deps);

			expect(readFileSync(join(basePath, "agent.yaml"), "utf8")).toContain(
				layoutVersion === 1 ? "database: memory/memories.db" : "database: data/signet.db",
			);
			const verifyDb = Database(dbPath, { readonly: true });
			expect(verifyDb.prepare("SELECT value FROM recovery_marker").get()).toEqual({ value: "preserve-me" });
			verifyDb.close();
			expect(startDaemon).toHaveBeenCalledWith(basePath);
		}
	}, 15000);
});
