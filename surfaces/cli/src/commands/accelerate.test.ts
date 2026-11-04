import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const command = new URL("./accelerate.ts", import.meta.url).href;
const feature = new URL("../features/accelerate/index.ts", import.meta.url).href;

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: readonly string[], setup = "", yaml = "embedding:\n  provider: native\n") {
	const dir = mkdtempSync(join(tmpdir(), "signet-accelerate-command-"));
	dirs.push(dir);
	writeFileSync(join(dir, "agent.yaml"), yaml);
	const child = spawnSync(
		process.execPath,
		[
			"-e",
			`
			import { createRequire } from "node:module";
			const { Command } = createRequire(${JSON.stringify(command)})("commander");
			const dir = ${JSON.stringify(dir)};
			let fetchFromDaemon = async () => ({ results: [{}], meta: { reranker: { kind: "cross-encoder", device: "cpu" } } });
			${setup}
			const { registerAccelerateCommands } = await import(${JSON.stringify(command)});
			const program = new Command();
			registerAccelerateCommands(program, { AGENTS_DIR: dir, fetchFromDaemon });
			await program.parseAsync(["bun", "signet", "accelerate", ...${JSON.stringify(args)}]);
			`,
		],
		{
			encoding: "utf8",
			timeout: 10_000,
			env: {
				...process.env,
				HOME: dir,
				HERMES_HOME: join(dir, ".hermes"),
				SIGNET_PATH: dir,
				SIGNET_DAEMON_URL: "",
				SIGNET_API_KEY: "",
				SIGNET_TOKEN: "",
				NO_COLOR: "1",
			},
		},
	);
	expect(child.error).toBeUndefined();
	return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe("accelerate status", () => {
	it("awaits runtime status for the default JSON and explicit status commands", () => {
		const json = run(["--json"]);
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			cpuRuntimeInstalled: false,
			embeddingRuntime: "wasm",
			rerankerDevice: "default",
		});
		const text = run(["status"]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("Native runtime      not installed");
		expect(text.stdout).not.toContain("undefined");
	});
});

describe("accelerate verify", () => {
	it("checks the awaited configured device before reporting verification success", () => {
		for (const device of ["cpu", "default"]) {
			const result = run(
				["verify"],
				`
				fetchFromDaemon = async () => ({ results: [{}], meta: { reranker: { kind: "cross-encoder", device: ${JSON.stringify(device)} } } });
			`,
				"memory:\n  pipelineV2:\n    reranker:\n      device: cpu\n",
			);
			expect(result.code).toBe(device === "cpu" ? 0 : 1);
			expect(result.stderr).toContain(device === "cpu" ? "Cross-encoder answered on cpu" : "ran on default, not cpu");
		}
	});

	it("bounds recall requests and poll sleeps to the remaining deadline", () => {
		const result = run(
			["verify", "--timeout", "5"],
			`
			let now = 0;
			const requests = [];
			const sleeps = [];
			Date.now = () => now;
			globalThis.setTimeout = (callback, ms) => { sleeps.push(ms); now += ms; callback(); };
			fetchFromDaemon = async (path, opts) => {
				requests.push({ path, ...opts });
				now += requests.length === 1 ? 3700 : 250;
				return { results: [{}], meta: { reranker: { kind: "embedding", fallback: "loading" } } };
			};
			process.on("beforeExit", () => console.log(JSON.stringify({ requests, sleeps, now })));
		`,
		);
		expect(result.code).toBe(1);
		const trace = JSON.parse(result.stdout);
		expect(trace.requests.map((request: { timeout: number }) => request.timeout)).toEqual([5000, 300]);
		expect(trace.sleeps).toEqual([1000, 50]);
		expect(trace.now).toBe(5000);
		expect(trace.requests[0]).toMatchObject({
			path: "/api/memory/recall",
			method: "POST",
			headers: { "content-type": "application/json" },
		});
		expect(JSON.parse(trace.requests[0].body)).toMatchObject({ limit: 3, trackRecallAccess: false });
		expect(result.stderr).toContain("did not answer within 5s (loading)");
	});

	it("aborts a stalled daemon request at the command timeout", () => {
		const daemon = new URL("../lib/daemon.ts", import.meta.url).href;
		const result = run(
			["verify", "--timeout", "5"],
			`
			const { createDaemonClient } = await import(${JSON.stringify(daemon)});
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise(() => {}) });
			const client = createDaemonClient(server.port);
			const start = performance.now();
			fetchFromDaemon = async (path, opts) => {
				try { return await client.fetchFromDaemon(path, opts); }
				finally { server.stop(true); console.log(performance.now() - start); }
			};
		`,
		);
		expect(result.code).toBe(1);
		expect(Number(result.stdout.trim())).toBeLessThan(6500);
	}, 15_000);

	it("stops an empty recall as not verified without claiming the runtime works", () => {
		const result = run(
			["verify", "--timeout", "5"],
			`
			let now = 0;
			let calls = 0;
			Date.now = () => now;
			globalThis.setTimeout = (callback, ms) => { now += ms; callback(); };
			fetchFromDaemon = async () => { calls++; return { results: [], meta: { noHits: true } }; };
			process.on("beforeExit", () => console.log(JSON.stringify({ calls, now })));
		`,
		);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({ calls: 1, now: 0 });
		expect(result.stderr).toMatch(/not verified.*no (matching memories|candidates)/i);
		expect(result.stderr).not.toContain("Cross-encoder answered");
		expect(result.stderr).not.toContain("did not answer within");
	});

	it("rejects non-finite and invalid timeout input before contacting the daemon", () => {
		for (const timeout of ["Infinity", "-Infinity", "NaN", "not-a-number", "1e309", "1e308"]) {
			const result = run(
				["verify", "--timeout", timeout],
				`fetchFromDaemon = async () => { console.log("RECALL"); return null; };`,
			);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("--timeout must be a finite number");
			expect(result.stdout).not.toContain("RECALL");
		}
	});
});

describe("accelerate configuration failures", () => {
	it.each(["cpu", "off"])(
		"reports missing, malformed, unwritable, and locked config without false %s success",
		(mode) => {
			for (const fixture of [
				{ yaml: "", setup: `const { rmSync } = await import("node:fs"); rmSync(dir + "/agent.yaml");` },
				{ yaml: "memory: [unclosed\n", setup: "" },
				{
					yaml: "embedding:\n  provider: native\n",
					setup: `const { mkdirSync } = await import("node:fs"); mkdirSync(dir + "/agent.yaml.bak");`,
				},
				{
					yaml: "embedding:\n  provider: native\n",
					setup: `const { writeFileSync } = await import("node:fs"); writeFileSync(dir + "/agent.yaml.lock", "");`,
				},
			]) {
				const result = run(
					[mode],
					`
				const { mock } = await import("bun:test");
				const actual = await import(${JSON.stringify(feature)});
				mock.module(${JSON.stringify(feature)}, () => ({ ...actual, installCpuRuntime: async () => "present" }));
				${fixture.setup}
			`,
					fixture.yaml,
				);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("Cannot update the Signet config:");
				expect(result.stderr).not.toContain("Unhandled");
				expect(result.stdout).not.toContain("Updated");
				expect(result.stdout).not.toContain("Restart the daemon");
			}
		},
	);
});
