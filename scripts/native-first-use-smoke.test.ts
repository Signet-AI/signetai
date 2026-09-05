/** Release regression guard for the compiled binary's first-install contract. */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const enabled = process.env.SIGNET_NATIVE_FIRST_USE_SMOKE === "1";
let smokeHome: string | null = null;
let daemonChild: ChildProcess | null = null;

function nativeSmokeBinary(): string {
	const override = process.env.SIGNET_NATIVE_SMOKE_BINARY;
	if (override) return resolve(root, override);
	const key = `${process.platform}-${process.arch}`;
	return join(root, "dist", "native", key.startsWith("win32-") ? `signet-${key}.exe` : `signet-${key}`);
}

function smokeEnv(home: string, workspace: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		SIGNET_PATH: workspace,
		SIGNET_TELEMETRY_ENABLED: "false",
		SIGNET_TELEMETRY_OPTOUT: "1",
		NO_COLOR: "1",
	};
}

function run(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): string {
	const result = spawnSync(binary, [...args], { env, encoding: "utf8", timeout });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) throw new Error(`${binary} ${args.join(" ")} failed: ${result.error.message}\n${output}`);
	if (result.status !== 0) throw new Error(`${binary} ${args.join(" ")} exited ${result.status}\n${output}`);
	return output;
}

function parseJsonOutput(output: string): Record<string, unknown> {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`command did not return JSON:\n${output}`);
	const parsed: unknown = JSON.parse(output.slice(start, end + 1));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`command returned non-object JSON:\n${output}`);
	}
	return parsed as Record<string, unknown>;
}

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	await server.stop(true);
	return port;
}

async function waitForHealth(origin: string, child: ChildProcess, output: () => string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`native daemon exited ${child.exitCode}\n${output()}`);
		try {
			const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`native daemon did not become healthy\n${output()}`);
}

async function stopDaemonChild(): Promise<void> {
	const child = daemonChild;
	daemonChild = null;
	if (child === null || child.exitCode !== null) return;
	await new Promise<void>((resolveClose) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolveClose();
		};
		child.once("close", finish);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
			finish();
		}, 5_000);
	});
}

afterEach(async () => {
	await stopDaemonChild();
	if (smokeHome === null) return;
	rmSync(smokeHome, { recursive: true, force: true });
	smokeHome = null;
});

describe("compiled native first use", () => {
	const smoke = enabled ? test : test.skip;

	smoke(
		"setup, doctor, remember, and recall work from a clean workspace",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			smokeHome = mkdtempSync(join(tmpdir(), "signet-native-first-use-"));
			const workspace = join(smokeHome, ".agents");
			const sourceCheckout = join(workspace, "signetai");
			const gitLog = join(smokeHome, "git-trace.log");
			const env = { ...smokeEnv(smokeHome, workspace), GIT_TRACE: gitLog, GIT_ALLOW_PROTOCOL: "" };
			const port = await freePort();
			const origin = `http://127.0.0.1:${port}`;

			run(
				binary,
				[
					"setup",
					"--non-interactive",
					"--path",
					workspace,
					"--name",
					"Native First-Use Smoke",
					"--identity-mode",
					"managed",
					"--identity-preset",
					"minimal",
					"--network-mode",
					"localhost",
					"--remote-url",
					origin,
					"--embedding-provider",
					"none",
					"--extraction-provider",
					"none",
					"--skip-git",
					"--disable-signet-secrets",
					"--disable-graphiq",
				],
				env,
				120_000,
			);

			expect(existsSync(sourceCheckout)).toBe(false);
			expect(existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "").not.toMatch(/\bgit (clone|fetch|pull)\b/);
			const agentYaml = readFileSync(join(workspace, "agent.yaml"), "utf8");
			expect(agentYaml).toContain("embedding:\n  provider: none");
			let daemonOutput = "";
			daemonChild = spawn(binary, [], {
				env: {
					...env,
					SIGNET_DAEMON_ENTRYPOINT: "1",
					SIGNET_PORT: String(port),
					SIGNET_BIND: "127.0.0.1",
					SIGNET_SKIP_AGENT_REGISTER: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			daemonChild.stdout?.setEncoding("utf8");
			daemonChild.stderr?.setEncoding("utf8");
			daemonChild.stdout?.on("data", (chunk: string) => {
				daemonOutput += chunk;
			});
			daemonChild.stderr?.on("data", (chunk: string) => {
				daemonOutput += chunk;
			});
			await waitForHealth(origin, daemonChild, () => daemonOutput);
			const cliEnv = { ...env, SIGNET_DAEMON_URL: origin };

			run(binary, ["sync"], cliEnv, 30000);
			expect(existsSync(sourceCheckout)).toBe(false);
			expect(existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "").not.toMatch(/\bgit (clone|fetch|pull)\b/);
			const doctor = run(binary, ["doctor"], cliEnv, 30_000);
			expect(doctor).not.toContain("Missing required identity files");
			const status = parseJsonOutput(run(binary, ["status", "--json"], cliEnv, 30_000));
			expect(status.validIdentity).toBe(true);

			const sentence = "The native first-use release phrase is cobalt kestrel.";
			const remembered = run(binary, ["remember", sentence], cliEnv, 30_000);
			expect(remembered).toContain("Saved memory");
			expect(remembered).toContain("no embedding");

			const startedAt = Date.now();
			const recall = parseJsonOutput(
				run(binary, ["recall", "What is the native first-use release phrase?", "--json"], cliEnv, 30_000),
			);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			const results = Array.isArray(recall.results) ? recall.results : [];
			expect(
				results.some((row) => typeof row === "object" && row !== null && Reflect.get(row, "content") === sentence),
			).toBe(true);
		},
		3 * 60_000,
	);
});
