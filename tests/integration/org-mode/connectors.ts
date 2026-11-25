import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { repo, terminateOwnedGroup } from "./daemon";
import { connector, type Fixture } from "./fixture";

export const harnesses = [
	"claude-code",
	"codex",
	"forge",
	"gemini",
	"hermes",
	"hermes-agent",
	"kimi",
	"muse-code",
	"opencode",
	"openclaw",
	"oh-my-pi",
	"pi",
] as const;
async function files(root: string): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const target = join(path, entry.name);
			if (entry.isDirectory()) await walk(target);
			else if (entry.isFile()) found.set(relative(root, target), await readFile(target));
			else assert(!entry.isSymbolicLink(), `Connector wrote an unverified symlink: ${relative(root, target)}`);
		}
	}
	await walk(root);
	return found;
}
async function seedHarnessHomes(root: string): Promise<void> {
	for (const [path, content] of [
		["home/.claude/settings.json", "{}"],
		["home/.codex/config.toml", ""],
		["home/.forge/.mcp.json", "{}"],
		["home/.gemini/settings.json", "{}"],
		["home/.kimi/config.toml", ""],
		["home/.config/opencode/opencode.jsonc", "{}"],
		["home/.openclaw/openclaw.json", "{}"],
		["xdg-config/muse/settings.json", "{}"],
		["home/.hermes/config.yaml", "memory:\n  provider: builtin\n"],
		["home/.hermes/profiles/acceptance/config.yaml", "memory:\n  provider: builtin\n"],
	] as const) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	await mkdir(join(root, "home/.pi/agent"), { recursive: true });
	await mkdir(join(root, "home/.omp/agent"), { recursive: true });
}
export async function connectorSecrets(fixture: Fixture): Promise<void> {
	const build = Bun.spawn([process.execPath, "run", "build:cli"], {
		cwd: join(repo, "surfaces/cli"),
		env: fixture.daemon.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
	assert.equal(await build.exited, 0, "Build surfaces/cli before checking connector provisioning");
	const failures: string[] = [];
	for (const harness of harnesses) {
		const root = join(fixture.daemon.root, `connector-${harness}`);
		const env = {
			...buildHermeticEnvironment({ PATH: process.env.PATH }, root),
			SIGNET_DAEMON_URL: fixture.daemon.origin,
			SIGNET_PATH: fixture.daemon.workspace,
			npm_config_prefix: join(root, "npm-global"),
		};
		await seedHarnessHomes(root);
		const before = await files(root);
		const user = fixture.user("alice");
		const provisioned = await connector(
			fixture.daemon,
			user.session,
			user.deviceId,
			user.agentId,
			harness === "hermes" ? "hermes-agent" : harness,
		);
		const secret = provisioned.credential.bearer;
		assert(secret);
		const child = Bun.spawn(
			[
				"setsid",
				process.execPath,
				join(repo, "surfaces/cli/dist/cli.js"),
				"--non-interactive",
				"connect",
				harness,
				"--api-key-stdin",
				"--url",
				fixture.daemon.origin,
				...(harness === "hermes" ? ["--profile", "acceptance"] : []),
			],
			{ env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		let argvLeak = false;
		let processSamples = 0;
		try {
			child.stdin.write(`${secret}\n`);
			child.stdin.end();
			const deadline = Date.now() + 30_000;
			do {
				const ps = Bun.spawn(["ps", "-eo", "args="], { stdout: "pipe" });
				const sample = await new Response(ps.stdout).text();
				assert.equal(await ps.exited, 0);
				processSamples++;
				argvLeak ||= sample.includes(secret) || sample.includes(provisioned.prefix);
				await Bun.sleep(20);
			} while (child.exitCode === null && Date.now() < deadline);
			if (child.exitCode === null) failures.push(`${harness}: CLI connect exceeded 30s`);
		} finally {
			await terminateOwnedGroup(child.pid);
		}
		const exit = await child.exited;
		await Promise.all([stdout, stderr]);
		assert(processSamples > 0, `${harness}: no process command lines were sampled`);
		assert(!argvLeak, `${harness}: key secret/prefix leaked into process argv`);
		if (exit !== 0) {
			failures.push(`${harness}: signet connect --api-key-stdin exited ${exit}`);
			continue;
		}
		const after = await files(root);
		const changed = [...after].filter(([path, content]) => !before.get(path)?.equals(content));
		assert(
			changed.some(([path]) =>
				/(?:\.claude|\.codex|\.forge|\.gemini|\.hermes|\.kimi|\/muse\/|\/opencode\/|\.openclaw|\.omp|\.pi)/.test(path),
			),
			`${harness}: connect wrote no harness configuration or extension; registry-only provisioning is not proof`,
		);
		for (const [path, content] of changed) {
			const protectedKeyFile = /(?:^|\/)signet\/(?:keys|login)\//.test(path);
			if (protectedKeyFile) {
				assert.equal((await stat(join(root, path))).mode & 0o777, 0o600, `${harness}: key/credential file permissions`);
				continue;
			}
			for (const needle of [secret, provisioned.prefix])
				assert(!content.includes(needle), `${harness}: key secret/prefix leaked into ${path}`);
		}
	}
	assert.equal(failures.length, 0, failures.join("\n"));
}
