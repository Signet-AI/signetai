import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	BENCH_CREDENTIAL_ENV,
	attachBenchCredential,
	buildMemoryBenchArgs,
	captureOpenRouterSnapshot,
	openRouterApiBaseUrl,
	openRouterSnapshotApiKey,
	openRouterSnapshotDir,
	openRouterSnapshotModels,
	openRouterSnapshotNeeded,
	writeOpenRouterSnapshot,
	benchUsesSubscription,
	benchDreamingCodemode,
	benchDreamingConcurrency,
	benchDreamingContextWindow,
	benchDreamingMaxOutputTokens,
	benchDreamingThinking,
	buildSetupArgs,
	isLocalEndpoint,
	loadEnvFile,
	pinnedBunMismatch,
	resolveBenchModel,
	resolveBenchRunId,
	setBenchDreamingCodemode,
	setBenchDreamingConcurrency,
	setBenchDreamingContextWindow,
	setBenchDreamingMaxOutputTokens,
	setBenchDreamingTimeout,
	benchDreamingTimeoutMs,
	setBenchDreamingThinking,
	benchDreamingPolicies,
	setBenchDreamingPolicies,
	benchApiKeyEnv,
	resolveBenchApiKey,
	benchDreamingOpenRouter,
	setBenchDreamingOpenRouter,
	setBenchRecallTranscriptEvidenceLimit,
	benchRecallTranscriptEvidenceLimit,
} from "./bench-memory";
import { loadMemoryConfig } from "../platform/daemon/src/memory-config";
import { parseRoutingConfig } from "../platform/core/src/routing";

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
	test("treats loopback inference endpoints as local so they need no API key", () => {
		expect(isLocalEndpoint("http://127.0.0.1:8000/v1")).toBe(true);
		expect(isLocalEndpoint("http://localhost:8000/v1")).toBe(true);
		expect(isLocalEndpoint("http://[::1]:8000/v1")).toBe(true);
		expect(isLocalEndpoint("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(false);
		expect(isLocalEndpoint("not a url")).toBe(false);
	});

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

	test("attaches a ChatGPT subscription account without an API key reference", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		attachBenchCredential(dir, "openai-codex");
		const config = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8"));
		const account = Object.values(config.inference.accounts as Record<string, Record<string, unknown>>).find(
			(entry) => entry.providerFamily === "openai-codex",
		);
		expect(account).toEqual({ kind: "subscription_session", providerFamily: "openai-codex" });
		expect(config.inference.targets.background.executor).toBe("openai-codex");
		expect(benchUsesSubscription("zai-coding-cn")).toBe(false);
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
		expect(benchDreamingConcurrency({ SIGNET_BENCH_DREAMING_CONCURRENCY: "128" })).toBe(128);
		expect(() => benchDreamingConcurrency({ SIGNET_BENCH_DREAMING_CONCURRENCY: "0" })).toThrow("from 1 to 256");
		expect(() => benchDreamingConcurrency({ SIGNET_BENCH_DREAMING_CONCURRENCY: "257" })).toThrow("from 1 to 256");
	});

	test("raises the Dreaming per-turn output budget only when the bench asks for it", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingMaxOutputTokens(dir, benchDreamingMaxOutputTokens({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({ enabled: true });
		setBenchDreamingMaxOutputTokens(
			dir,
			benchDreamingMaxOutputTokens({ SIGNET_BENCH_DREAMING_MAX_OUTPUT_TOKENS: "16384" }),
		);
		const config = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8"));
		expect(config.memory.dreaming).toEqual({ enabled: true, maxOutputTokens: 16384 });
		expect(config.inference.targets.background.executor).toBe("openai-compatible");
		expect(() => benchDreamingMaxOutputTokens({ SIGNET_BENCH_DREAMING_MAX_OUTPUT_TOKENS: "10" })).toThrow(
			"from 1000 to 1000000",
		);
	});

	test("sets the Dreaming pass timeout only when asked", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingTimeout(dir, benchDreamingTimeoutMs({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({ enabled: true });
		setBenchDreamingTimeout(dir, benchDreamingTimeoutMs({ SIGNET_BENCH_DREAMING_TIMEOUT_MS: "1800000" }));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({
			enabled: true,
			timeout: 1_800_000,
		});
		expect(() => benchDreamingTimeoutMs({ SIGNET_BENCH_DREAMING_TIMEOUT_MS: "3600000" })).toThrow(
			"from 30000 to 1800000",
		);
	});

	test("writes the recall transcript evidence limit only when asked and the daemon reads it back", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchRecallTranscriptEvidenceLimit(dir, benchRecallTranscriptEvidenceLimit({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).search).toBeUndefined();
		setBenchRecallTranscriptEvidenceLimit(
			dir,
			benchRecallTranscriptEvidenceLimit({ SIGNET_BENCH_RECALL_TRANSCRIPT_EVIDENCE_LIMIT: "0" }),
		);
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).search).toEqual({ transcript_evidence_limit: 0 });
		setBenchRecallTranscriptEvidenceLimit(
			dir,
			benchRecallTranscriptEvidenceLimit({ SIGNET_BENCH_RECALL_TRANSCRIPT_EVIDENCE_LIMIT: "5" }),
		);
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).search).toEqual({ transcript_evidence_limit: 5 });
		setBenchRecallTranscriptEvidenceLimit(dir, benchRecallTranscriptEvidenceLimit({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).search).toBeUndefined();
		expect(() => benchRecallTranscriptEvidenceLimit({ SIGNET_BENCH_RECALL_TRANSCRIPT_EVIDENCE_LIMIT: "6" })).toThrow(
			"from 0 to 5",
		);
		expect(() => benchRecallTranscriptEvidenceLimit({ SIGNET_BENCH_RECALL_TRANSCRIPT_EVIDENCE_LIMIT: "-1" })).toThrow(
			"from 0 to 5",
		);
		expect(() => benchRecallTranscriptEvidenceLimit({ SIGNET_BENCH_RECALL_TRANSCRIPT_EVIDENCE_LIMIT: "two" })).toThrow(
			"from 0 to 5",
		);
		setBenchRecallTranscriptEvidenceLimit(
			dir,
			benchRecallTranscriptEvidenceLimit({ SIGNET_BENCH_RECALL_TRANSCRIPT_EVIDENCE_LIMIT: "5" }),
		);
		expect(loadMemoryConfig(dir).search.transcript_evidence_limit).toBe(5);
	});

	test("writes Dreaming pass policies from a file only when asked", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingPolicies(dir, benchDreamingPolicies({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({ enabled: true });
		const file = join(dir, "policies.json");
		await writeFile(file, JSON.stringify({ combined: "File decisions only.\n", hygiene: "Merge duplicates." }));
		setBenchDreamingPolicies(dir, benchDreamingPolicies({ SIGNET_BENCH_DREAMING_POLICIES_FILE: file }));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({
			enabled: true,
			policies: { combined: "File decisions only.\n", hygiene: "Merge duplicates." },
		});
		await writeFile(file, JSON.stringify({ compact: "x" }));
		expect(() => benchDreamingPolicies({ SIGNET_BENCH_DREAMING_POLICIES_FILE: file })).toThrow("unknown pass type");
		await writeFile(file, JSON.stringify({ content: " " }));
		expect(() => benchDreamingPolicies({ SIGNET_BENCH_DREAMING_POLICIES_FILE: file })).toThrow("non-empty text");
		await writeFile(file, JSON.stringify({ content: "x".repeat(64_000) }));
		expect(benchDreamingPolicies({ SIGNET_BENCH_DREAMING_POLICIES_FILE: file })?.content).toHaveLength(64_000);
		await writeFile(file, JSON.stringify({ content: "x".repeat(64_001) }));
		expect(() => benchDreamingPolicies({ SIGNET_BENCH_DREAMING_POLICIES_FILE: file })).toThrow(
			"more than 64,000 characters",
		);
	});

	test("sets the Dreaming model context window only when asked", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingContextWindow(dir, benchDreamingContextWindow({}));
		expect(
			parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).inference.targets.background.models.default,
		).toEqual({ model: "glm-5.3-flash" });
		setBenchDreamingContextWindow(dir, benchDreamingContextWindow({ SIGNET_BENCH_DREAMING_CONTEXT_WINDOW: "262144" }));
		expect(
			parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).inference.targets.background.models.default,
		).toEqual({ model: "glm-5.3-flash", contextWindow: 262144 });
		expect(() => benchDreamingContextWindow({ SIGNET_BENCH_DREAMING_CONTEXT_WINDOW: "1000" })).toThrow(
			"from 8192 to 2000000",
		);
	});

	test("writes local thinking control onto the background target only when asked", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingThinking(dir, benchDreamingThinking({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).inference.targets.background.thinking).toBe(
			undefined,
		);
		const thinking = { format: "chat-template", budgetTokens: 2000 };
		setBenchDreamingThinking(dir, benchDreamingThinking({ SIGNET_BENCH_DREAMING_THINKING: JSON.stringify(thinking) }));
		const config = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8"));
		expect(config.inference.targets.background.thinking).toEqual(thinking);
		expect(config.inference.targets.background.executor).toBe("openai-compatible");
		expect(() => benchDreamingThinking({ SIGNET_BENCH_DREAMING_THINKING: "nope" })).toThrow("JSON object");
		expect(() => benchDreamingThinking({ SIGNET_BENCH_DREAMING_THINKING: "{}" })).toThrow("needs a format");
	});

	test("turns Dreaming codemode on only when the bench asks for it", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);
		setBenchDreamingCodemode(dir, benchDreamingCodemode({}));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({ enabled: true });
		setBenchDreamingCodemode(dir, benchDreamingCodemode({ SIGNET_BENCH_DREAMING_CODEMODE: "1" }));
		expect(parseYaml(await readFile(join(dir, "agent.yaml"), "utf8")).memory.dreaming).toEqual({
			enabled: true,
			codemode: true,
		});
		expect(() => benchDreamingCodemode({ SIGNET_BENCH_DREAMING_CODEMODE: "yes" })).toThrow("must be 1, 0");
	});

	test("runs Dreaming through the OpenRouter executor with the routing block", async () => {
		const dir = await workspace();
		await writeFile(join(dir, "agent.yaml"), setupAgentYaml);

		expect(benchApiKeyEnv("openrouter")).toBe("OPENROUTER_API_KEY");
		expect(benchApiKeyEnv("zai-coding-cn")).toBe("ZAI_API_KEY");
		expect(resolveBenchApiKey({ SIGNET_BENCH_DREAMING_API_KEY: " dreaming-key " }, "openrouter")).toBe("dreaming-key");
		expect(resolveBenchApiKey({ OPENROUTER_API_KEY: "or-key" }, "openrouter")).toBe("or-key");
		expect(resolveBenchApiKey({ ZAI_API_KEY: "zai-key" }, "zai-coding-cn")).toBe("zai-key");
		expect(resolveBenchApiKey({ OPENROUTER_API_KEY: "or-key", ZAI_API_KEY: "zai-key" }, "zai-coding-cn")).toBe(
			"zai-key",
		);

		attachBenchCredential(dir, "openrouter");
		const openrouter = benchDreamingOpenRouter({
			SIGNET_BENCH_DREAMING_OPENROUTER: JSON.stringify({
				reasoning: { enabled: true, max_tokens: 4096 },
				provider: {
					order: ["deepinfra", "together"],
					allow_fallbacks: false,
					data_collection: "deny",
					quantizations: ["fp8", "fp16"],
					sort: "price",
					max_price: { prompt: 2, completion: 8 },
				},
			}),
		});
		setBenchDreamingOpenRouter(dir, openrouter);

		const config = parseYaml(await readFile(join(dir, "agent.yaml"), "utf8"));
		const target = config.inference.targets.background;
		expect(target.executor).toBe("openrouter");
		expect(target.endpoint).toBeUndefined();
		expect(target.account).toBe("memorybench");
		expect(target.openrouter).toEqual({
			reasoning: { enabled: true, max_tokens: 4096 },
			provider: {
				order: ["deepinfra", "together"],
				allow_fallbacks: false,
				data_collection: "deny",
				quantizations: ["fp8", "fp16"],
				sort: "price",
				max_price: { prompt: 2, completion: 8 },
			},
		});

		const parsed = parseRoutingConfig(config);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.targets.background?.openrouter).toEqual({
			reasoning: { enabled: true, maxTokens: 4096 },
			provider: {
				order: ["deepinfra", "together"],
				allow_fallbacks: false,
				data_collection: "deny",
				quantizations: ["fp8", "fp16"],
				sort: "price",
				max_price: { prompt: 2, completion: 8 },
			},
		});

		expect(benchDreamingOpenRouter({})).toBeUndefined();
		expect(() => benchDreamingOpenRouter({ SIGNET_BENCH_DREAMING_OPENROUTER: "nope" })).toThrow("JSON object");
		expect(() => benchDreamingOpenRouter({ SIGNET_BENCH_DREAMING_OPENROUTER: "[1]" })).toThrow("JSON object");
		expect(() =>
			benchDreamingOpenRouter({ SIGNET_BENCH_DREAMING_OPENROUTER: JSON.stringify({ thinking: {} }) }),
		).toThrow("unknown key");
	});

	test("refuses a Bun other than the one package.json pins", () => {
		expect(pinnedBunMismatch("bun@1.4.2", "1.4.2", "/usr/bin/bun")).toBeNull();
		expect(pinnedBunMismatch(undefined, "1.3.8", "/usr/bin/bun")).toBeNull();
		const mismatch = pinnedBunMismatch("bun@1.4.2", "1.3.8", "/home/u/node_modules/bun/bin/bun.exe");
		expect(mismatch).toContain("pinned Bun 1.4.2");
		expect(mismatch).toContain("Bun 1.3.8 at /home/u/node_modules/bun/bin/bun.exe");
	});

	test("authenticates snapshot fetches with only OPENROUTER_API_KEY", async () => {
		const seen: (string | null)[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				seen.push(new URL(request.url).searchParams.get("none") ?? request.headers.get("authorization"));
				return Response.json({ data: { usage: 1 } });
			},
		});
		try {
			expect(openRouterSnapshotApiKey({ OPENROUTER_API_KEY: "or-key" })).toBe("or-key");
			expect(
				openRouterSnapshotApiKey({ OPENROUTER_API_KEY: "or-key", SIGNET_BENCH_DREAMING_API_KEY: "dream-key" }),
			).toBe("or-key");
			expect(openRouterSnapshotApiKey({ SIGNET_BENCH_DREAMING_API_KEY: "dream-key" })).toBe("");
			await captureOpenRouterSnapshot(
				`http://127.0.0.1:${server.port}/api/v1`,
				openRouterSnapshotApiKey({ OPENROUTER_API_KEY: "or-key", SIGNET_BENCH_DREAMING_API_KEY: "dream-key" }),
				[],
			);
			expect(seen.every((authorization) => authorization === "Bearer or-key")).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("writes snapshots outside the memorybench run directory", () => {
		const dir = openRouterSnapshotDir("run-1");
		expect(dir.endsWith(join("memorybench", "data", "openrouter-snapshots", "run-1"))).toBe(true);
		expect(dir.includes(join("memorybench", "data", "runs"))).toBe(false);
	});

	test("resolves the run id once across flags, env, and default", () => {
		const previousRunId = process.env.SIGNET_BENCH_RUN_ID;
		delete process.env.SIGNET_BENCH_RUN_ID;
		try {
			expect(resolveBenchRunId(["run", "-r", "flag-run"], "dreaming")).toBe("flag-run");
			expect(resolveBenchRunId(["run", "--run-id", "long-run"], "dreaming")).toBe("long-run");
			expect(resolveBenchRunId(["run", "--run-id=eq-run"], "dreaming")).toBe("eq-run");
			expect(resolveBenchRunId(["run", "-r=eq-short"], "dreaming")).toBe("eq-short");
			expect(resolveBenchRunId(["run", "-r", "flag-run"], "dreaming")).toBe("flag-run");
			process.env.SIGNET_BENCH_RUN_ID = "env-run";
			expect(resolveBenchRunId(["run"], "dreaming")).toBe("env-run");
			expect(resolveBenchRunId(["run", "-r", "flag-run"], "dreaming")).toBe("flag-run");
			delete process.env.SIGNET_BENCH_RUN_ID;
			const args = buildMemoryBenchArgs(["run", "-r", "flag-run"], false, "dreaming", true, "one-run");
			expect(args[args.indexOf("-r") + 1]).toBe("flag-run");
			const defaulted = buildMemoryBenchArgs(["run", "-b", "locomo"], false, "dreaming", true, "one-run");
			expect(defaulted[defaulted.indexOf("-r") + 1]).toBe("one-run");
		} finally {
			if (previousRunId !== undefined) process.env.SIGNET_BENCH_RUN_ID = previousRunId;
			else delete process.env.SIGNET_BENCH_RUN_ID;
		}
	});

	test("fetches endpoints with each model path segment encoded separately", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const { pathname } = new URL(request.url);
				if (pathname.includes("%2F")) return new Response("not found", { status: 404 });
				if (!pathname.endsWith("/endpoints")) return Response.json({ data: { usage: 1 } });
				return Response.json({ data: { endpoints: [{ provider_name: "DeepInfra" }] } });
			},
		});
		try {
			const snapshot = await captureOpenRouterSnapshot(`http://127.0.0.1:${server.port}/api/v1`, "or-test-key", [
				"openai/gpt-4o",
			]);
			const endpointResult = snapshot.endpoints["openai/gpt-4o"];
			if (!Array.isArray(endpointResult)) throw new Error("endpoint snapshot errored");
			expect(endpointResult).toBeArrayOfSize(1);
			expect(endpointResult[0]).toMatchObject({ provider_name: "DeepInfra" });
		} finally {
			server.stop(true);
		}
	});

	test("detects snapshot models from judge and answering-model CLI args", () => {
		const env = { SIGNET_BENCH_ANSWERING_MODEL: "openrouter:a/b" };
		expect(openRouterSnapshotModels(env, "zai-coding-cn", ["run", "-j", "openrouter:c/d"])).toEqual(["a/b", "c/d"]);
		expect(openRouterSnapshotModels(env, "zai-coding-cn", ["run", "--answering-model=openrouter:e/f"])).toEqual([
			"a/b",
			"e/f",
		]);
		expect(
			openRouterSnapshotModels({}, "zai-coding-cn", ["run", "--judge=openrouter:g/h", "-m=openrouter:i/j"]),
		).toEqual(["g/h", "i/j"]);
		expect(openRouterSnapshotModels({}, "zai-coding-cn", ["run", "-j", "glm-5.3-flash"])).toEqual([]);
		expect(openRouterSnapshotNeeded({}, "zai-coding-cn", ["run", "--judge", "openrouter:c/d"])).toBe(true);
		expect(openRouterSnapshotNeeded({}, "zai-coding-cn", ["run", "--judge", "glm-5.3-flash"])).toBe(false);
	});

	test("removes a stale recall evidence limit when the env is unset", async () => {
		const root = await workspace();
		const agentsDir = join(root, "agents");
		await Bun.write(join(agentsDir, "agent.yaml"), setupAgentYaml);
		setBenchRecallTranscriptEvidenceLimit(agentsDir, 3);
		expect((parseYaml(await Bun.file(join(agentsDir, "agent.yaml")).text()) as { search?: unknown }).search).toEqual({
			transcript_evidence_limit: 3,
		});
		setBenchRecallTranscriptEvidenceLimit(agentsDir, undefined);
		expect(
			(parseYaml(await Bun.file(join(agentsDir, "agent.yaml")).text()) as { search?: unknown }).search,
		).toBeUndefined();
	});

	test("names the default run id after the selected benchmark", () => {
		const previousRunId = process.env.SIGNET_BENCH_RUN_ID;
		delete process.env.SIGNET_BENCH_RUN_ID;
		try {
			const shortFlag = buildMemoryBenchArgs(["run", "-b", "locomo"], false, "dreaming", true);
			expect(shortFlag[shortFlag.indexOf("-r") + 1]).toContain("-locomo-");
			expect(shortFlag.join(" ")).toContain("-b locomo");

			const defaultBenchmark = buildMemoryBenchArgs(["run"], false, "dreaming", true);
			expect(defaultBenchmark[defaultBenchmark.indexOf("-r") + 1]).toContain("-longmemeval-");
			expect(defaultBenchmark.join(" ")).toContain("-b longmemeval");

			const longFlag = buildMemoryBenchArgs(["run", "--benchmark", "beam-1m"], false, "dreaming", true);
			expect(longFlag[longFlag.indexOf("-r") + 1]).toContain("-beam-1m-");

			const equalsFlag = buildMemoryBenchArgs(["run", "--benchmark=locomo"], false, "dreaming", true);
			expect(equalsFlag[equalsFlag.indexOf("-r") + 1]).toContain("-locomo-");
			expect(equalsFlag.join(" ")).not.toContain("-b longmemeval");
		} finally {
			if (previousRunId !== undefined) process.env.SIGNET_BENCH_RUN_ID = previousRunId;
			else delete process.env.SIGNET_BENCH_RUN_ID;
		}
	});

	test("captures an OpenRouter price snapshot without leaking key material", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const url = new URL(request.url);
				requests.push({ url: url.pathname, authorization: request.headers.get("authorization") });
				if (url.pathname.endsWith("/key")) {
					return Response.json({
						data: {
							label: "bench-key",
							hash: "sk-or-v1-secret",
							usage: 12.5,
							usage_daily: 3.25,
							limit: 100,
							limit_remaining: 87.5,
							rate_limits: { requests: 1 },
						},
					});
				}
				return Response.json({
					data: {
						id: "deepseek/deepseek-v4.1-flash-1017",
						endpoints: [
							{
								provider_name: "DeepInfra",
								tag: "fp8",
								quantization: "fp8",
								context_length: 163840,
								pricing: { prompt: "0.0000002", completion: "0.0000008" },
								supported_parameters: ["temperature"],
							},
							42,
						],
					},
				});
			},
		});
		const root = await workspace();
		try {
			const baseUrl = `http://127.0.0.1:${server.port}/api/v1`;
			expect(openRouterApiBaseUrl({ SIGNET_BENCH_OPENROUTER_BASE_URL: baseUrl })).toBe(baseUrl);
			expect(openRouterApiBaseUrl({})).toBe("https://openrouter.ai/api/v1");
			expect(openRouterSnapshotModels({}, "zai-coding-cn")).toEqual([]);
			expect(
				openRouterSnapshotModels(
					{ SIGNET_BENCH_ANSWERING_MODEL: "openrouter:a/b", SIGNET_BENCH_JUDGE: "openrouter:c/d" },
					"zai-coding-cn",
				),
			).toEqual(["a/b", "c/d"]);
			expect(openRouterSnapshotNeeded({}, "zai-coding-cn")).toBe(false);
			expect(openRouterSnapshotNeeded({}, "openrouter")).toBe(true);

			const snapshot = await captureOpenRouterSnapshot(baseUrl, "or-test-key", ["a/b"]);
			const startPath = writeOpenRouterSnapshot(root, "start", snapshot);
			const endPath = writeOpenRouterSnapshot(root, "end", snapshot);

			expect(requests.every((request) => request.authorization === "Bearer or-test-key")).toBe(true);
			const start = JSON.parse(await readFile(startPath, "utf8")) as Record<string, unknown>;
			expect(start.timestamp).toBeString();
			expect(start.key).toEqual({ usage: 12.5, usage_daily: 3.25, limit: 100, limit_remaining: 87.5 });
			expect(start.endpoints).toEqual({
				"a/b": [
					{
						provider_name: "DeepInfra",
						tag: "fp8",
						quantization: "fp8",
						context_length: 163840,
						pricing: { prompt: "0.0000002", completion: "0.0000008" },
					},
				],
			});
			const startText = await readFile(startPath, "utf8");
			expect(startText).not.toContain("bench-key");
			expect(startText).not.toContain("sk-or-v1-secret");
			expect(startText).not.toContain("or-test-key");
			expect(await readFile(endPath, "utf8")).toEqual(startText);
		} finally {
			server.stop(true);
		}
	});

	test("records snapshot fetch failures as errors instead of aborting", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("nope", { status: 500 }),
		});
		const root = await workspace();
		try {
			const snapshot = await captureOpenRouterSnapshot(`http://127.0.0.1:${server.port}/api/v1`, "or-test-key", [
				"a/b",
			]);
			const path = writeOpenRouterSnapshot(root, "end", snapshot);
			const written = JSON.parse(await readFile(path, "utf8")) as {
				key: { error?: string };
				endpoints: Record<string, { error?: string }>;
			};
			expect(written.key.error).toContain("failed with 500");
			expect(written.endpoints["a/b"]?.error).toContain("failed with 500");
		} finally {
			server.stop(true);
		}
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
