import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";

const daemonScript = join(import.meta.dir, "daemon.ts");
const tempDirs: string[] = [];

function runtimeEnv(root: string, workspace: string, port: number): NodeJS.ProcessEnv {
	return {
		...buildHermeticEnvironment({ PATH: process.env.PATH, LANG: "C.UTF-8" }, root),
		SIGNET_PATH: workspace,
		SIGNET_WORKSPACE: "",
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		SIGNET_DAEMON_ENTRYPOINT: "1",
		SIGNET_EMBEDDING_WARM_NATIVE: "false",
		SIGNET_TELEMETRY_OPTOUT: "1",
		SIGNET_ANALYTICS_DISABLED: "1",
	};
}

async function freePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	server.stop(true);
	return port;
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	throw new Error("daemon observation timed out");
}

function startDaemon(env: NodeJS.ProcessEnv) {
	const child = Bun.spawn([process.execPath, daemonScript], {
		cwd: join(import.meta.dir, "../../.."),
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	let output = "";
	async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
		for await (const chunk of stream) output += new TextDecoder().decode(chunk);
	}
	const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
	return {
		child,
		output: () => output,
		async stop() {
			if (child.exitCode === null) child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
			try {
				await child.exited;
				await drained;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

async function runDaemon(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	const daemon = startDaemon(env);
	try {
		await until(() => daemon.child.exitCode !== null);
	} finally {
		await daemon.stop();
	}
	return { code: daemon.child.exitCode, output: daemon.output() };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon workspace startup preflight", () => {
	it("rejects malformed selected config before creating runtime state", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-invalid-config-startup-"));
		tempDirs.push(root);
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "memory"), { recursive: true });
		const config = "embedding: [\nauth:\n  mode: team\n";
		const configPath = join(workspace, "agent.yaml");
		writeFileSync(configPath, config);
		writeFileSync(join(workspace, "memory", "memories.db"), "");

		const result = await runDaemon(runtimeEnv(root, workspace, await freePort()));

		expect(result.code).toBe(1);
		expect(result.output).toContain(`${configPath}: invalid YAML syntax`);
		expect(readFileSync(configPath, "utf8")).toBe(config);
		expect(Bun.file(join(workspace, "memory", "memories.db")).size).toBe(0);
		expect(Bun.file(join(workspace, ".daemon", "pid")).exists()).resolves.toBe(false);
		expect(Bun.file(join(root, "home", ".agents")).exists()).resolves.toBe(false);
	}, 30_000);

	it("applies team auth before the first listener response and retains it on rejected reload", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-team-auth-startup-"));
		tempDirs.push(root);
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "memory"), { recursive: true });
		writeFileSync(join(workspace, "memory", "memories.db"), "");
		const config = [
			"version: 1",
			"configVersion: 9",
			"embedding:",
			"  provider: none",
			"auth:",
			"  mode: team",
			"capabilities:",
			"  identity:",
			"    mode: off",
			"memory:",
			"  pipelineV2:",
			"    enabled: false",
			"",
		].join("\n");
		const configPath = join(workspace, "agent.yaml");
		writeFileSync(configPath, config);
		const rejected = config.replace("  mode: team", "  mode: config-redaction-sentinel");
		const port = await freePort();
		const daemon = startDaemon(runtimeEnv(root, workspace, port));
		try {
			await until(async () => {
				try {
					return (await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(250) })).ok;
				} catch {
					return false;
				}
			});
			const firstResponse = await fetch(`http://127.0.0.1:${port}/api/memory/recall`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "first response auth", agentId: "config-review" }),
				signal: AbortSignal.timeout(5_000),
			});
			expect(firstResponse.status).toBe(401);

			writeFileSync(configPath, rejected);
			await until(() => daemon.output().includes("Rejected runtime config change"));
			const output = daemon.output();
			expect(output).toContain("Rejected runtime config change");
			const afterReload = await fetch(`http://127.0.0.1:${port}/api/memory/recall`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "after rejected reload", agentId: "config-review" }),
				signal: AbortSignal.timeout(5_000),
			});
			expect(afterReload.status).toBe(401);
			expect(readFileSync(configPath, "utf8")).toBe(rejected);
			expect(output).not.toContain("config-redaction-sentinel");
		} finally {
			await daemon.stop();
		}
		expect(daemon.child.exitCode).toBe(0);
		expect(Bun.file(join(workspace, ".daemon", "pid")).exists()).resolves.toBe(false);
	}, 60_000);

	it("fails closed when the configured workspace is moved aside", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-workspace-startup-"));
		tempDirs.push(root);
		const workspace = join(root, "workspace");
		const movedWorkspace = join(root, "moved-workspace");
		const configHome = join(root, "config");
		mkdirSync(join(workspace, "memory"), { recursive: true });
		mkdirSync(join(configHome, "signet"), { recursive: true });
		writeFileSync(join(workspace, "agent.yaml"), "name: Regression\n");
		writeFileSync(join(workspace, "memory", "memories.db"), "existing database\n");
		writeFileSync(
			join(configHome, "signet", "workspace.json"),
			JSON.stringify({ version: 1, workspace, updatedAt: new Date().toISOString() }),
		);
		// Keep the established workspace intact under a different name. The
		// startup path must not recreate the configured location.
		renameSync(workspace, movedWorkspace);

		const result = await runDaemon({
			...process.env,
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: configHome,
			SIGNET_PATH: "",
			SIGNET_WORKSPACE: "",
			SIGNET_PORT: "39817",
			SIGNET_DISABLE_TELEMETRY: "1",
			SIGNET_ANALYTICS_DISABLED: "1",
		});

		expect(result.code).toBe(1);
		expect(result.output).toContain("Signet cannot start: missing workspace");
		expect(result.output).toContain("will not recreate it");
		expect(readFileSync(join(movedWorkspace, "agent.yaml"), "utf8")).toContain("Regression");
		expect(Bun.file(workspace).exists()).resolves.toBe(false);
	});
});
