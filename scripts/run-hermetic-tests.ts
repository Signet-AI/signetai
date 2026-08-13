import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stage 1 isolates process environment and filesystem roots only. Provider
 * fixtures, generated artifacts, shared database state, and parallel-suite
 * coordination remain later hermetic-runner stages.
 */
export const CLEARED_ENV_KEYS = [
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
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_STATE_HOME",
	"OPENCLAW_HOME",
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
] as const;

type HermeticEnvironment = NodeJS.ProcessEnv;

function createHermeticRoot(): string {
	const candidates = [tmpdir(), import.meta.dir];
	for (const candidate of candidates) {
		try {
			return mkdtempSync(join(candidate, "signet-test-run-"));
		} catch {}
	}
	throw new Error("Unable to create a temporary hermetic test root");
}

export function buildHermeticEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	root: string = createHermeticRoot(),
): HermeticEnvironment {
	const home = join(root, "home");
	const config = join(root, "xdg-config");
	const data = join(root, "xdg-data");
	const cache = join(root, "xdg-cache");
	const state = join(root, "xdg-state");
	const runtime = join(root, "xdg-runtime");
	const temporary = join(root, "tmp");
	for (const directory of [home, config, data, cache, state, runtime, temporary]) {
		mkdirSync(directory, { recursive: true });
	}

	const env: HermeticEnvironment = { ...baseEnv };
	for (const key of CLEARED_ENV_KEYS) delete env[key];
	env.HOME = home;
	env.TMPDIR = temporary;
	env.TMP = temporary;
	env.TEMP = temporary;
	env.USERPROFILE = home;
	env.HOMEDRIVE = home;
	env.HOMEPATH = home;
	env.XDG_CONFIG_HOME = config;
	env.XDG_DATA_HOME = data;
	env.XDG_CACHE_HOME = cache;
	env.XDG_STATE_HOME = state;
	env.XDG_RUNTIME_DIR = runtime;
	return env;
}

function run(): number {
	const root = createHermeticRoot();
	try {
		const result = spawnSync(process.execPath, ["test", ...process.argv.slice(2)], {
			cwd: join(import.meta.dir, ".."),
			env: buildHermeticEnvironment(process.env, root),
			stdio: "inherit",
		});
		if (result.error) throw result.error;
		return result.status ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exitCode = run();
