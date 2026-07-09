import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-native-hermes-smoke-"));
	tempDirs.push(dir);
	return dir;
}

function run(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
	return spawnSync(binary, args, {
		cwd,
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
	const start = stdout.indexOf("{");
	if (start < 0) throw new Error(`command did not emit JSON: ${stdout}`);
	return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("native Hermes release smoke", () => {
	const binary = process.env.SIGNET_NATIVE_SMOKE_BINARY?.trim();
	const hermesFixture = process.env.SIGNET_HERMES_SMOKE_REPO?.trim();
	const smoke = binary && hermesFixture ? test : test.skip;

	smoke(
		"sync and doctor materialize the current Hermes provider from a binary-only package",
		() => {
			if (!binary || !hermesFixture) throw new Error("native Hermes smoke environment is incomplete");
			expect(existsSync(binary)).toBe(true);
			expect(existsSync(join(hermesFixture, "plugins", "memory", "__init__.py"))).toBe(true);

			const root = tempDir();
			const home = join(root, "home");
			const workspace = join(home, ".agents");
			const hermesHome = join(home, ".hermes");
			const hermesRepo = join(root, "hermes-agent");
			mkdirSync(workspace, { recursive: true });
			cpSync(hermesFixture, hermesRepo, { recursive: true });
			writeFileSync(join(workspace, "agent.yaml"), "harnesses:\n  - hermes-agent\nembedding:\n  provider: none\n");

			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: home,
				SIGNET_PATH: workspace,
				HERMES_HOME: hermesHome,
				HERMES_REPO: hermesRepo,
				PYTHON: process.env.PYTHON?.trim() || "python3",
				SIGNET_SKIP_AGENT_REGISTER: "1",
			};
			// biome-ignore lint/performance/noDelete: clean-home smoke must not inherit source/runtime fallbacks
			delete env.SIGNET_DIR;
			// biome-ignore lint/performance/noDelete: prove the binary materializes and sets its own embedded asset tree
			delete env.SIGNET_CONNECTOR_ASSETS_DIR;

			const sync = run(binary, ["sync"], env, root);
			expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0);
			expect(sync.stdout).not.toContain("Hermes Agent integration setup failed");

			const userPluginDir = join(hermesHome, "plugins", "signet");
			const repoPluginDir = join(hermesRepo, "plugins", "memory", "signet");
			for (const pluginDir of [userPluginDir, repoPluginDir]) {
				for (const name of ["__init__.py", "client.py", "plugin.yaml", "README.md", "signet.install.json"]) {
					expect(existsSync(join(pluginDir, name)), `${pluginDir}/${name}`).toBe(true);
				}
			}

			const marker = JSON.parse(readFileSync(join(userPluginDir, "signet.install.json"), "utf8")) as {
				connectorVersion?: unknown;
				sourceHash?: unknown;
			};
			const expectedVersion = process.env.SIGNET_NATIVE_SMOKE_VERSION?.trim();
			if (expectedVersion) expect(marker.connectorVersion).toBe(expectedVersion);
			expect(marker.sourceHash).toMatch(/^[a-f0-9]{64}$/);

			const doctor = run(binary, ["doctor", "hermes", "--json"], env, root);
			expect(doctor.status, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
			const report = parseJsonOutput(doctor.stdout) as {
				checks?: Array<{ id?: string; ok?: boolean }>;
				toolNames?: string[];
			};
			expect(report.checks?.find((check) => check.id === "plugin-source")?.ok).toBe(true);
			expect(report.checks?.find((check) => check.id === "user-plugin")?.ok).toBe(true);
			expect(report.checks?.find((check) => check.id === "repo-plugin")?.ok).toBe(true);
			expect(report.checks?.find((check) => check.id === "tool-routing")?.ok).toBe(true);
			expect(report.toolNames).toEqual(
				expect.arrayContaining([
					"memory_search",
					"memory_store",
					"memory_get",
					"memory_list",
					"memory_modify",
					"memory_forget",
					"signet_session_search",
					"recall",
					"remember",
				]),
			);
			expect(report.toolNames).not.toContain("session_search");

			const providerProbe = spawnSync(
				env.PYTHON || "python3",
				[
					"-c",
					[
						"import json",
						"from plugins.memory import load_memory_provider",
						"provider = load_memory_provider('signet')",
						"print(json.dumps(sorted(schema['name'] for schema in provider.get_tool_schemas())))",
					].join("\n"),
				],
				{ cwd: hermesRepo, env: { ...env, PYTHONPATH: hermesRepo }, encoding: "utf8", timeout: 10_000 },
			);
			expect(providerProbe.status, `${providerProbe.stdout}\n${providerProbe.stderr}`).toBe(0);
			const toolNames = JSON.parse(providerProbe.stdout) as string[];
			expect(toolNames).toContain("signet_session_search");
			expect(toolNames).not.toContain("session_search");

			// The package under test intentionally needs no Signet source checkout or
			// sibling runtime directory: its only required release payload is the binary.
			expect(basename(binary)).toMatch(/^signet(?:-|$)/);
		},
		120_000,
	);
});
