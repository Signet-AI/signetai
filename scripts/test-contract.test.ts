import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

const MAINTAINED_TEST_ROOTS = [
	"scripts",
	"tests",
	"platform/core",
	"platform/daemon",
	"platform/native",
	"surfaces/cli",
	"surfaces/dashboard",
	"surfaces/desktop",
	"surfaces/tray",
	"integrations",
	"libs",
	"memorybench",
	"web/workers",
];

const WORKSPACE_TEST_COMMAND = packageJson.scripts["test:workspace"];
const DIRECTORY_TEST_COMMAND =
	WORKSPACE_TEST_COMMAND.split(" && ").find((command) => command.startsWith("bun test ")) ?? "";
const HERMETIC_TEST_COMMAND =
	WORKSPACE_TEST_COMMAND.split(" && ").find((command) => command.startsWith("bun run test:hermetic ")) ?? "";

test("the root test command covers every maintained test root", () => {
	const scripts = packageJson.scripts;
	expect(scripts.test).toBe("bun run test:workspace");
	expect(WORKSPACE_TEST_COMMAND).toBeDefined();

	for (const root of MAINTAINED_TEST_ROOTS) {
		expect(HERMETIC_TEST_COMMAND).toContain(root);
	}

	expect(HERMETIC_TEST_COMMAND).toContain("bun run test:hermetic ");
	expect(DIRECTORY_TEST_COMMAND).toBe("");
	expect(HERMETIC_TEST_COMMAND).not.toContain("--filter");
	expect(HERMETIC_TEST_COMMAND).not.toContain("references");
});

test("the hermetic test runner owns host-sensitive paths and overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "signet-test-contract-"));
	const probe = join(root, "hermetic-env-probe.test.ts");
	try {
		writeFileSync(
			probe,
			`import { expect, test } from "bun:test";

test("hermetic environment", () => {
	expect(process.env.HOME).toMatch(/signet-test-run-/);
	expect(process.env.TMPDIR).toMatch(/signet-test-run-/);
	expect(process.env.XDG_CONFIG_HOME).toMatch(/signet-test-run-/);
	expect(process.env.XDG_DATA_HOME).toMatch(/signet-test-run-/);
	expect(process.env.XDG_CACHE_HOME).toMatch(/signet-test-run-/);
	expect(process.env.SIGNET_PATH).toBeUndefined();
	expect(process.env.SIGNET_DAEMON_URL).toBeUndefined();
	expect(process.env.SIGNET_AGENT_WORKSPACE).toBeUndefined();
	expect(process.env.SIGNET_AGENT_ID).toBeUndefined();
	expect(process.env.SIGNET_HOST).toBeUndefined();
	expect(process.env.SIGNET_PORT).toBeUndefined();
});
`,
		);
		const result = spawnSync(process.execPath, ["scripts/run-hermetic-tests.ts", probe], {
			cwd: join(import.meta.dir, ".."),
			env: {
				...process.env,
				HOME: "/host/home",
				TMPDIR: "/host/tmp",
				SIGNET_PATH: "/host/agents",
				SIGNET_DAEMON_URL: "http://host.example:3850",
				SIGNET_AGENT_WORKSPACE: "/host/workspace",
				SIGNET_AGENT_ID: "host-agent",
				SIGNET_HOST: "host.example",
				SIGNET_PORT: "3999",
				XDG_CONFIG_HOME: "/host/config",
				XDG_DATA_HOME: "/host/data",
				XDG_CACHE_HOME: "/host/cache",
			},
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the root test command retains the Codex plugin package smoke test", () => {
	expect(WORKSPACE_TEST_COMMAND).toContain("bun run --filter '@signet/codex-plugin' test");
});

test("the root test command builds workspace runtime dependencies before hermetic test roots", () => {
	expect(WORKSPACE_TEST_COMMAND).toContain("bun run build && bun run test:hermetic ");
});

test("the root test contract installs OpenCode's runtime test dependency", () => {
	expect(packageJson.devDependencies["@opencode-ai/plugin"]).toBeDefined();
});
