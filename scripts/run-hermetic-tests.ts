import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ISOLATED_ENV_KEYS = [
	"HOME",
	"TMPDIR",
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
] as const;

type HermeticEnvironment = NodeJS.ProcessEnv;

function createHermeticRoot(): string {
	return mkdtempSync(join("/tmp", "signet-test-run-"));
}

export function buildHermeticEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	root: string = createHermeticRoot(),
): HermeticEnvironment {
	const home = join(root, "home");
	const config = join(root, "xdg-config");
	const data = join(root, "xdg-data");
	const cache = join(root, "xdg-cache");
	const temporary = join(root, "tmp");
	for (const directory of [home, config, data, cache, temporary]) mkdirSync(directory, { recursive: true });

	const env: HermeticEnvironment = { ...baseEnv };
	for (const key of ISOLATED_ENV_KEYS) delete env[key];
	env.HOME = home;
	env.TMPDIR = temporary;
	env.XDG_CONFIG_HOME = config;
	env.XDG_DATA_HOME = data;
	env.XDG_CACHE_HOME = cache;
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
