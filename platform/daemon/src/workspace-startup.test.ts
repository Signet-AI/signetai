import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
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

async function waitForLive(child: ReturnType<typeof spawn>, port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && child.exitCode === null) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(250) });
			if (response.ok) return;
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("daemon did not expose /health/live before timeout");
}

function captureOutput(child: ReturnType<typeof spawn>): () => string {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return () => output;
}

async function waitForOutput(
	getOutput: () => string,
	child: ReturnType<typeof spawn>,
	needle: string,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !getOutput().includes(needle) && child.exitCode === null) {
		await Bun.sleep(50);
	}
	return getOutput();
}

async function stopDaemon(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, 12_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function runDaemon(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [daemonScript], {
			cwd: join(import.meta.dir, "../../.."),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const timer = setTimeout(async () => {
			await stopDaemon(child);
			reject(new Error(`daemon did not fail closed in time\n${output}`));
		}, 10_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			void stopDaemon(child);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
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
		const child = spawn(process.execPath, [daemonScript], {
			cwd: join(import.meta.dir, "../../.."),
			env: runtimeEnv(root, workspace, port),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const getOutput = captureOutput(child);
		try {
			await waitForLive(child, port);
			const firstResponse = await fetch(`http://127.0.0.1:${port}/api/memory/recall`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "first response auth", agentId: "config-review" }),
				signal: AbortSignal.timeout(5_000),
			});
			expect(firstResponse.status).toBe(401);

			writeFileSync(configPath, rejected);
			const output = await waitForOutput(getOutput, child, "Rejected runtime config change");
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
			await stopDaemon(child);
		}
		expect(child.exitCode).toBe(0);
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
