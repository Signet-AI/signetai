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
const CLEARED_ENV_KEYS = [
	"SIGNET_PATH",
	"SIGNET_WORKSPACE",
	"SIGNET_DAEMON_URL",
	"SIGNET_AGENT_WORKSPACE",
	"SIGNET_AGENT_ID",
	"SIGNET_HOST",
	"SIGNET_PORT",
	"SIGNET_API_KEY",
	"SIGNET_TOKEN",
	"SIGNET_TRUSTED_DAEMON_ORIGINS",
	"AGENTS_DIR",
	"SIGNET_AGENTS_DIR",
	"CODEX_HOME",
	"HERMES_HOME",
	"HERMES_REPO",
	"FORGE_CONFIG",
	"OPENCLAW_CONFIG_PATH",
	"CLAWDBOT_CONFIG_PATH",
	"OPENCLAW_STATE_DIR",
	"CLAWDBOT_STATE_DIR",
	"OPENCLAW_STATE_HOME",
	"OPENCLAW_HOME",
	"CLAWDBOT_HOME",
	"MOLDBOT_HOME",
	"MOLTBOT_HOME",
	"PI_CODING_AGENT_DIR",
	"SIGNET_DREAMING_AGENT_ID",
	"SIGNET_NO_HOOKS",
	"SIGNET_ENABLED",
	"SIGNET_BYPASS",
	"SIGNET_CONNECTOR_ASSETS_DIR",
	"SIGNET_DIR",
	"SIGNET_TEMPLATES_DIR",
	"SIGNET_SKILLS_SOURCE",
	"SIGNET_DATABASE_INTEGRITY_DB_PATH",
	"SIGNET_AGENT_READ_POLICY",
	"SIGNET_AGENT_MEMORY_POLICY",
	"SIGNET_AGENT_POLICY_GROUP",
	"SIGNET_SKIP_AGENT_REGISTER",
	"SIGNET_RUNTIME_PATH",
	"SIGNET_DASHBOARD_DIR",
	"SIGNET_WRAPPER_DIR",
	"SIGNET_BASE_URL",
	"SIGNET_ACP_ALLOWED_ORIGINS",
	"SIGNET_TELEMETRY_OPTOUT",
	"SIGNET_TELEMETRY_ENV",
	"SIGNET_TELEMETRY_DEPLOYMENT_ROLE",
	"SIGNET_TELEMETRY_INSTALL_CHANNEL",
] as const;

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

const CLEARED_ENV_KEYS = ${JSON.stringify(CLEARED_ENV_KEYS)} as const;

test("hermetic environment", () => {
	expect(process.env.HOME).toMatch(/signet-test-run-/);
	expect(process.env.TMPDIR).toMatch(/signet-test-run-/);
	expect(process.env.TMP).toMatch(/signet-test-run-/);
	expect(process.env.TEMP).toMatch(/signet-test-run-/);
	expect(process.env.USERPROFILE).toMatch(/signet-test-run-/);
	expect(process.env.HOMEDRIVE).toMatch(/signet-test-run-/);
	expect(process.env.HOMEPATH).toMatch(/signet-test-run-/);
	expect(process.env.XDG_CONFIG_HOME).toMatch(/signet-test-run-/);
	expect(process.env.XDG_DATA_HOME).toMatch(/signet-test-run-/);
	expect(process.env.XDG_CACHE_HOME).toMatch(/signet-test-run-/);
	expect(process.env.XDG_STATE_HOME).toMatch(/signet-test-run-/);
	expect(process.env.XDG_RUNTIME_DIR).toMatch(/signet-test-run-/);
	for (const key of CLEARED_ENV_KEYS) {
		expect(process.env[key]).toBeUndefined();
	}
});
`,
		);
		const result = spawnSync(process.execPath, ["scripts/run-hermetic-tests.ts", probe], {
			cwd: join(import.meta.dir, ".."),
			env: {
				...process.env,
				HOME: "/host/home",
				TMPDIR: root,
				TMP: root,
				TEMP: root,
				USERPROFILE: "/host/user-profile",
				HOMEDRIVE: "C:",
				HOMEPATH: "\\host\\home",
				SIGNET_PATH: "/host/agents",
				SIGNET_DAEMON_URL: "http://host.example:3850",
				SIGNET_AGENT_WORKSPACE: "/host/workspace",
				SIGNET_AGENT_ID: "host-agent",
				SIGNET_HOST: "host.example",
				SIGNET_PORT: "3999",
				XDG_CONFIG_HOME: "/host/config",
				XDG_DATA_HOME: "/host/data",
				XDG_CACHE_HOME: "/host/cache",
				XDG_STATE_HOME: "/host/state",
				XDG_RUNTIME_DIR: "/host/runtime",
				SIGNET_API_KEY: "host-api-key",
				SIGNET_TOKEN: "host-token",
				SIGNET_TRUSTED_DAEMON_ORIGINS: "https://host.example",
				AGENTS_DIR: "/host/agents",
				SIGNET_AGENTS_DIR: "/host/signet-agents",
				CODEX_HOME: "/host/codex",
				HERMES_HOME: "/host/hermes",
				HERMES_REPO: "/host/hermes-repo",
				FORGE_CONFIG: "/host/forge",
				OPENCLAW_CONFIG_PATH: "/host/openclaw.json",
				CLAWDBOT_CONFIG_PATH: "/host/clawdbot.json",
				OPENCLAW_STATE_DIR: "/host/openclaw-state",
				CLAWDBOT_STATE_DIR: "/host/clawdbot-state",
				OPENCLAW_STATE_HOME: "/host/openclaw-state-home",
				OPENCLAW_HOME: "/host/openclaw-home",
				CLAWDBOT_HOME: "/host/clawdbot-home",
				MOLDBOT_HOME: "/host/moldbot-home",
				MOLTBOT_HOME: "/host/moltbot-home",
				PI_CODING_AGENT_DIR: "/host/pi",
				SIGNET_DREAMING_AGENT_ID: "host-dreaming-agent",
				SIGNET_NO_HOOKS: "1",
				SIGNET_ENABLED: "false",
				SIGNET_BYPASS: "1",
				SIGNET_CONNECTOR_ASSETS_DIR: "/host/connectors",
				SIGNET_DIR: "/host/signet",
				SIGNET_TEMPLATES_DIR: "/host/templates",
				SIGNET_SKILLS_SOURCE: "/host/skills",
				SIGNET_DATABASE_INTEGRITY_DB_PATH: "/host/integrity.db",
				SIGNET_AGENT_READ_POLICY: "host-policy",
				SIGNET_AGENT_MEMORY_POLICY: "host-memory-policy",
				SIGNET_AGENT_POLICY_GROUP: "host-policy-group",
				SIGNET_SKIP_AGENT_REGISTER: "1",
				SIGNET_RUNTIME_PATH: "plugin",
				SIGNET_DASHBOARD_DIR: "/host/dashboard",
				SIGNET_WRAPPER_DIR: "/host/wrapper",
				SIGNET_BASE_URL: "http://host.example:3850",
				SIGNET_ACP_ALLOWED_ORIGINS: "http://host.example",
				SIGNET_TELEMETRY_OPTOUT: "0",
				SIGNET_TELEMETRY_ENV: "production",
				SIGNET_TELEMETRY_DEPLOYMENT_ROLE: "host-role",
				SIGNET_TELEMETRY_INSTALL_CHANNEL: "host-channel",
			},
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
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
