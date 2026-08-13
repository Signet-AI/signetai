import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ISOLATED_ENV_KEYS = [
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"SIGNET_PATH",
	"SIGNET_WORKSPACE",
	"SIGNET_DAEMON_URL",
	"SIGNET_AGENT_WORKSPACE",
	"SIGNET_AGENT_ID",
	"SIGNET_HOST",
	"SIGNET_PORT",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"SIGNET_API_KEY",
	"SIGNET_TOKEN",
	"SIGNET_TRUSTED_DAEMON_ORIGINS",
] as const;

type HermeticEnvironment = NodeJS.ProcessEnv;

function createHermeticRoot(): string {
	return mkdtempSync(join(tmpdir(), "signet-test-run-"));
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
	for (const key of ISOLATED_ENV_KEYS) delete env[key];
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
