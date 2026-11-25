import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile, realpath, readlink, cp } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { repo, terminateOwnedGroup } from "./daemon";
import type { Fixture } from "./fixture";
import { ConnectorRegistry, readKeyFile } from "../../../libs/sdk/src/node";

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
async function files(root: string, allowedRoot: string): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const target = join(path, entry.name);
			if (entry.isDirectory()) await walk(target);
			else if (entry.isFile()) found.set(relative(root, target), await readFile(target));
			else if (entry.isSymbolicLink()) {
				const resolved = await realpath(target);
				const within = relative(allowedRoot, resolved);
				assert(
					within !== ".." && !within.startsWith("../") && !within.startsWith("/"),
					`Connector link escapes disposable fixture: ${relative(root, target)}`,
				);
				found.set(relative(root, target), Buffer.from(await readlink(target)));
			}
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
		["xdg-config/muse/settings.json", '{"schema_version":1}'],
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
			SIGNET_CONNECTOR_ASSETS_DIR: join(root, "assets"),
		};
		await seedHarnessHomes(root);
		await cp(
			join(repo, "integrations/hermes-agent/connector/hermes-plugin"),
			join(root, "assets/hermes-agent/hermes-plugin"),
			{ recursive: true },
		);
		const before = await files(root, fixture.daemon.root);
		const user = fixture.user("alice");
		const session = user.session.bearer;
		assert(session);
		const samples: string[] = [];
		const child = Bun.spawn(
			[
				"setsid",
				process.execPath,
				join(repo, "surfaces/cli/dist/cli.js"),
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
			child.stdin.write(`${session}\n`);
			child.stdin.end();
			const deadline = Date.now() + 30_000;
			do {
				const ps = Bun.spawn(["ps", "-eo", "args="], { stdout: "pipe" });
				const sample = await new Response(ps.stdout).text();
				assert.equal(await ps.exited, 0);
				processSamples++;
				samples.push(sample);
				await Bun.sleep(20);
			} while (child.exitCode === null && Date.now() < deadline);
			if (child.exitCode === null) failures.push(`${harness}: CLI connect exceeded 30s`);
		} finally {
			await terminateOwnedGroup(child.pid);
		}
		const exit = await child.exited;
		const [out, err] = await Promise.all([stdout, stderr]);
		assert(processSamples > 0, `${harness}: no process command lines were sampled`);

		if (exit !== 0) {
			failures.push(
				`${harness}: signet connect --api-key-stdin exited ${exit}: ${`${out}\n${err}`
					.replaceAll(session, "[redacted]")
					.replace(/sig_sk_\S+/g, "[redacted]")
					.slice(0, 2000)}`,
			);
			continue;
		}
		const entries = Object.values(await new ConnectorRegistry({ env }).read());
		assert.equal(entries.length, 1, `${harness}: unexpected registry partition count`);
		const entry = entries[0];
		assert(entry?.keyFile, `${harness}: no registry key file`);
		const secret = await readKeyFile(entry.keyFile);
		const prefix = secret.slice("sig_sk_".length).split("_")[0];
		assert(prefix && prefix.length >= 12, `${harness}: invalid issued key format`);
		argvLeak = samples.some((sample) => [secret, prefix, session].some((needle) => sample.includes(needle)));
		assert(!argvLeak, `${harness}: credential secret/prefix leaked into process argv`);
		const after = await files(root, fixture.daemon.root);
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
			for (const needle of [secret, prefix, session])
				assert(!content.includes(needle), `${harness}: key secret/prefix leaked into ${path}`);
		}
	}
	assert.equal(failures.length, 0, failures.join("\n"));
}
