import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	BENCH_CREDENTIAL_ENV,
	attachBenchCredential,
	benchDreamingConcurrency,
	buildSetupArgs,
	loadEnvFile,
	resolveBenchModel,
	setBenchDreamingConcurrency,
} from "./bench-memory";

const workspaces: string[] = [];

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "signet-memorybench-launcher-"));
	workspaces.push(path);
	return path;
}

const setupAgentYaml = `memory:
  dreaming:
    enabled: true
inference:
  defaultPolicy: background
  targets:
    background:
      executor: openai-compatible
      models:
        default:
          model: glm-5.3-flash
      endpoint: https://open.bigmodel.cn/api/coding/paas/v4
`;

describe("MemoryBench launcher", () => {
	test("sets the workspace up through real Signet setup without letting setup start a daemon", () => {
		const args = buildSetupArgs("/tmp/bench/agents", 47123, resolveBenchModel({}));

		expect(args.slice(0, 2)).toEqual(["surfaces/cli/src/cli.ts", "setup"]);
		expect(args).toContain("--non-interactive");
		expect(args.join(" ")).toContain("--path /tmp/bench/agents");
		expect(args.join(" ")).toContain("--remote-url http://127.0.0.1:47123");
		expect(args.join(" ")).toContain("--extraction-model glm-5.3-flash");
		expect(args.join(" ")).toContain("--extraction-endpoint https://open.bigmodel.cn/api/coding/paas/v4");
	});

	test("defaults to GLM-5.3-Flash on the Z.ai coding endpoint and honors overrides", () => {
		expect(resolveBenchModel({})).toEqual({
			model: "glm-5.3-flash",
			endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
			providerFamily: "zai-coding-cn",
		});
		expect(
			resolveBenchModel({
				SIGNET_BENCH_DREAMING_MODEL: "local-model",
				SIGNET_BENCH_DREAMING_ENDPOINT: "http://127.0.0.1:8000/v1",
				SIGNET_BENCH_DREAMING_PROVIDER_FAMILY: "openai-compatible",
			}),
		).toEqual({ model: "local-model", endpoint: "http://127.0.0.1:8000/v1", providerFamily: "openai-compatible" });
	});

	test("adds only an API credential to the inference target setup wrote", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);

		attachBenchCredential(dir, "zai-coding-cn");

		const config = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8"));
		expect(config.inference.accounts.memorybench).toEqual({
			kind: "api",
			providerFamily: "zai-coding-cn",
			credentialRef: BENCH_CREDENTIAL_ENV,
		});
		expect(config.inference.targets.background).toEqual({
			executor: "zai-coding-cn",
			models: { default: { model: "glm-5.3-flash" } },
			account: "memorybench",
			privacy: "restricted_remote",
		});
		expect(config.memory).toEqual({ dreaming: { enabled: true } });
	});

	test("keeps a generic OpenAI-compatible endpoint for a local model", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);

		attachBenchCredential(dir, "openai-compatible");

		const target = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).inference.targets.background;
		expect(target.executor).toBe("openai-compatible");
		expect(target.endpoint).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
	});

	test("refuses a workspace without the setup-written background target", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: true\n");

		expect(() => attachBenchCredential(dir, "zai-coding-cn")).toThrow("background inference target");
	});

	test("raises Dreaming concurrency for bulk ingest without touching other settings", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingConcurrency(dir, benchDreamingConcurrency({}));
		const config = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8"));
		expect(config.memory.dreaming).toEqual({ enabled: true, maxConcurrentPasses: 6 });
		expect(config.memory.pipelineV2.worker.maxLlmConcurrency).toBe(8);
		expect(config.inference.targets.background.executor).toBe("openai-compatible");
		expect(benchDreamingConcurrency({ SIGNET_BENCH_DREAMING_CONCURRENCY: "2" })).toBe(2);
		expect(() => benchDreamingConcurrency({ SIGNET_BENCH_DREAMING_CONCURRENCY: "0" })).toThrow("from 1 to 16");
	});

	test("loads the bench env file without overriding values already set", async () => {
		const dir = await workspace();
		const path = join(dir, ".env");
		await writeFile(path, 'ZAI_API_KEY="from-file"\nEXISTING=from-file\n# comment\nBARE=value\n');
		const env: NodeJS.ProcessEnv = { EXISTING: "from-shell" };

		loadEnvFile(path, env);
		loadEnvFile(join(dir, "missing.env"), env);

		expect(env).toEqual({ ZAI_API_KEY: "from-file", EXISTING: "from-shell", BARE: "value" });
	});
});
