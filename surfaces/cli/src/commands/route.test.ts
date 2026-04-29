import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerRouteCommands } from "./route";

const prevLog = console.log;
const prevError = console.error;
const prevExit = process.exit;
const tempDirs: string[] = [];

afterEach(() => {
	console.log = prevLog;
	console.error = prevError;
	Object.defineProperty(process, "exit", {
		configurable: true,
		value: prevExit,
	});
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		rmSync(dir, { recursive: true, force: true });
	}
});

function createProgram(agentsDir: string): Command {
	const program = new Command();
	registerRouteCommands(program, {
		AGENTS_DIR: agentsDir,
		fetchFromDaemon: async () => null,
		secretApiCall: async () => ({ ok: false, data: null }),
	});
	return program;
}

describe("registerRouteCommands", () => {
	test("route test rejects invalid max token values before daemon calls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const errors: string[] = [];
		let called = false;
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		Object.defineProperty(process, "exit", {
			configurable: true,
			value(code?: string | number | null | undefined) {
				throw new Error(`exit ${code ?? 0}`);
			},
		});
		const program = new Command();
		registerRouteCommands(program, {
			AGENTS_DIR: dir,
			fetchFromDaemon: async () => null,
			secretApiCall: async () => {
				called = true;
				return { ok: true, data: null };
			},
		});

		await expect(program.parseAsync(["node", "test", "route", "test", "hello", "--max-tokens", "abc"])).rejects.toThrow(
			"exit 1",
		);

		expect(called).toBe(false);
		expect(errors.join("\n")).toContain("--max-tokens must be a positive integer");
	});

	test("route test forwards valid max token values as numbers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		let requestBody: unknown;
		console.log = () => {};
		const program = new Command();
		registerRouteCommands(program, {
			AGENTS_DIR: dir,
			fetchFromDaemon: async () => null,
			secretApiCall: async (_method, _path, body) => {
				requestBody = body;
				return { ok: true, data: { text: "ok" } };
			},
		});

		await program.parseAsync(["node", "test", "route", "test", "hello", "--max-tokens", "42"]);

		expect(requestBody).toMatchObject({ maxTokens: 42 });
	});

	test("route test rejects invalid timeout values before daemon calls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const errors: string[] = [];
		let called = false;
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		Object.defineProperty(process, "exit", {
			configurable: true,
			value(code?: string | number | null | undefined) {
				throw new Error(`exit ${code ?? 0}`);
			},
		});
		const program = new Command();
		registerRouteCommands(program, {
			AGENTS_DIR: dir,
			fetchFromDaemon: async () => null,
			secretApiCall: async () => {
				called = true;
				return { ok: true, data: null };
			},
		});

		await expect(program.parseAsync(["node", "test", "route", "test", "hello", "--timeout", "0"])).rejects.toThrow(
			"exit 1",
		);

		expect(called).toBe(false);
		expect(errors.join("\n")).toContain("--timeout must be a positive integer");
	});

	test("route test forwards valid timeout values to the daemon request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		let requestTimeout: number | undefined;
		console.log = () => {};
		const program = new Command();
		registerRouteCommands(program, {
			AGENTS_DIR: dir,
			fetchFromDaemon: async () => null,
			secretApiCall: async (_method, _path, _body, timeoutMs) => {
				requestTimeout = timeoutMs;
				return { ok: true, data: { text: "ok" } };
			},
		});

		await program.parseAsync(["node", "test", "route", "test", "hello", "--timeout", "60000"]);

		expect(requestTimeout).toBe(60000);
	});

	test("route pin refuses to rewrite an existing agent.yaml without explicit confirmation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const agentYamlPath = join(dir, "agent.yaml");
		const original = "# keep this operator note\nidentity:\n  name: tester\n";
		writeFileSync(agentYamlPath, original);

		const errors: string[] = [];
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		Object.defineProperty(process, "exit", {
			configurable: true,
			value(code?: string | number | null | undefined) {
				throw new Error(`exit ${code ?? 0}`);
			},
		});

		await expect(createProgram(dir).parseAsync(["node", "test", "route", "pin", "primary/fast"])).rejects.toThrow(
			"exit 1",
		);

		expect(readFileSync(agentYamlPath, "utf-8")).toBe(original);
		expect(errors.join("\n")).toContain("--rewrite-agent-yaml");
	});

	test("route pin rejects malformed target refs before writing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const agentYamlPath = join(dir, "agent.yaml");
		writeFileSync(agentYamlPath, "identity:\n  name: tester\n");
		const errors: string[] = [];
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		Object.defineProperty(process, "exit", {
			configurable: true,
			value(code?: string | number | null | undefined) {
				throw new Error(`exit ${code ?? 0}`);
			},
		});

		await expect(
			createProgram(dir).parseAsync(["node", "test", "route", "pin", "not-a-target", "--rewrite-agent-yaml"]),
		).rejects.toThrow("exit 1");

		expect(readFileSync(agentYamlPath, "utf-8")).toBe("identity:\n  name: tester\n");
		expect(errors.join("\n")).toContain("Expected target/model");
	});

	test("route pin rejects unknown target refs when inference targets are configured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const agentYamlPath = join(dir, "agent.yaml");
		writeFileSync(
			agentYamlPath,
			`inference:
  targets:
    local:
      executor: ollama
      models:
        gemma:
          model: gemma
`,
		);
		const errors: string[] = [];
		console.error = (line?: unknown) => {
			errors.push(String(line ?? ""));
		};
		Object.defineProperty(process, "exit", {
			configurable: true,
			value(code?: string | number | null | undefined) {
				throw new Error(`exit ${code ?? 0}`);
			},
		});

		await expect(
			createProgram(dir).parseAsync(["node", "test", "route", "pin", "remote/sonnet", "--rewrite-agent-yaml"]),
		).rejects.toThrow("exit 1");

		expect(readFileSync(agentYamlPath, "utf-8")).not.toContain("pinnedTargets");
		expect(errors.join("\n")).toContain('Unknown target ref "remote/sonnet"');
		expect(errors.join("\n")).toContain("local/gemma");
	});

	test("route pin rewrites agent.yaml only when explicitly confirmed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-route-command-"));
		tempDirs.push(dir);
		const agentYamlPath = join(dir, "agent.yaml");
		writeFileSync(agentYamlPath, "# keep this operator note\nidentity:\n  name: tester\n");
		console.log = () => {};

		await createProgram(dir).parseAsync(["node", "test", "route", "pin", "primary/fast", "--rewrite-agent-yaml"]);

		const yaml = readFileSync(agentYamlPath, "utf-8");
		expect(yaml).toContain("pinnedTargets:");
		expect(yaml).toContain("default: primary/fast");
	});
});
