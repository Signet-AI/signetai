import { afterEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProviderForTests, resetOAuthStateForTests, storeOAuthCredentials } from "./inference-oauth";
import { getOrCreateInferenceRouter, resetInferenceRouterForTests } from "./inference-router";
import { invalidateSecretsCache } from "./secrets";

const originalFetch = globalThis.fetch;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalSignetPath = process.env.SIGNET_PATH;
const REVOKED_OAUTH_PROVIDER_ID = "signet-router-review-oauth";

/** Build an OpenAI-compatible SSE streaming response (pi-ai's openai-completions transport streams). */
function openAiSseResponse(
	content: string,
	usage?: { readonly prompt_tokens: number; readonly completion_tokens: number },
): Response {
	const chunks = [
		`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], ...(usage ? { usage } : {}) })}\n\n`,
		"data: [DONE]\n\n",
	];
	return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function writeDreamingAcpxAgentFixture(root: string): {
	readonly argsPath: string;
	readonly mcpConfigPathPath: string;
	readonly mcpConfigCopyPath: string;
} {
	mkdirSync(join(root, "memory"), { recursive: true });
	const bin = join(root, "fake-dreaming-acpx.sh");
	const argsPath = join(root, "acpx-args.txt");
	const mcpConfigPathPath = join(root, "acpx-mcp-path.txt");
	const mcpConfigCopyPath = join(root, "acpx-mcp.json");
	writeFileSync(
		bin,
		`#!/usr/bin/env bash
printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then
    printf '%s' "$2" > ${JSON.stringify(mcpConfigPathPath)}
    cp "$2" ${JSON.stringify(mcpConfigCopyPath)}
    break
  fi
  shift
done
cat >/dev/null
printf 'dreaming agent completed\\n'
`,
	);
	chmodSync(bin, 0o755);
	writeFileSync(
		join(root, "agent.yaml"),
		`inference:
  defaultPolicy: dreaming
  targets:
    dreaming:
      executor: acpx
      acpx:
        agent: codex
        bin: ${bin}
        permissions: deny-all
        hooks: disabled
        terminal: false
      models:
        default:
          model: gpt-5.4-mini
  policies:
    dreaming:
      mode: strict
      defaultTargets:
        - dreaming/default
  workloads:
    memoryExtraction:
      policy: dreaming
`,
	);
	return { argsPath, mcpConfigPathPath, mcpConfigCopyPath };
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetOAuthStateForTests();
	invalidateSecretsCache();
	if (originalSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = originalSignetPath;
	if (originalOpenRouterApiKey === undefined) {
		process.env.OPENROUTER_API_KEY = undefined;
	} else {
		process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
	}
	if (originalOpenAiApiKey === undefined) {
		process.env.OPENAI_API_KEY = undefined;
	} else {
		process.env.OPENAI_API_KEY = originalOpenAiApiKey;
	}
	resetInferenceRouterForTests();
});

describe("InferenceRouter legacy API credentials", () => {
	it("runs an ACPX agent with one ephemeral agent-scoped Dreaming MCP binding", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-dreaming-acpx-"));
		const fixture = writeDreamingAcpxAgentFixture(dir);
		try {
			const router = getOrCreateInferenceRouter(dir);
			const result = await router.runAgent(
				{ operation: "memory_extraction", promptPreview: "consolidate selected evidence" },
				"Use the supplied evidence and daemon tools.",
				[],
				{
					acpxMcp: {
						agentId: "agent-a",
						passId: "pass-a",
						daemonUrl: "http://127.0.0.1:3850",
						authorizationToken: "scoped-agent-token",
					},
				},
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.decision.targetRef).toBe("dreaming/default");
			expect(result.value.attempts).toEqual([expect.objectContaining({ targetRef: "dreaming/default", ok: true })]);

			const args = readFileSync(fixture.argsPath, "utf8").trim().split("\n");
			expect(args).toContain("--mcp-config");
			const mcpConfigPath = readFileSync(fixture.mcpConfigPathPath, "utf8");
			expect(args[args.indexOf("--mcp-config") + 1]).toBe(mcpConfigPath);
			const mcpConfig = JSON.parse(readFileSync(fixture.mcpConfigCopyPath, "utf8")) as {
				mcpServers: Array<{
					name: string;
					env: Array<{ name: string; value: string }>;
				}>;
			};
			expect(mcpConfig.mcpServers).toHaveLength(1);
			expect(mcpConfig.mcpServers[0]).toMatchObject({ name: "signet_dreaming" });
			expect(mcpConfig.mcpServers[0]?.env).toEqual(
				expect.arrayContaining([
					{ name: "SIGNET_DREAMING_AGENT_ID", value: "agent-a" },
					{ name: "SIGNET_DREAMING_PASS_ID", value: "pass-a" },
					{ name: "SIGNET_DAEMON_URL", value: "http://127.0.0.1:3850" },
					{ name: "SIGNET_TOKEN", value: "scoped-agent-token" },
				]),
			);
			expect(existsSync(mcpConfigPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforces the agent-session deadline when the agent loop never returns (#1168)", async () => {
		// Regression for #1168: the router set an abort timer for the agent
		// session but still awaited session.prompt() unconditionally — if the
		// abort did not settle the prompt, runAgent (and the Dreaming pass)
		// hung past every deadline. The prompt must be raced against the
		// deadline so runAgent returns and disposes the session either way.
		const dir = mkdtempSync(join(tmpdir(), "signet-router-agent-deadline-"));
		const bin = join(dir, "fake-sleeping-agent.sh");
		writeFileSync(
			bin,
			`#!/usr/bin/env bash
printf '%s\\n' "$@" > ${JSON.stringify(join(dir, "args.txt"))}
sleep 60
printf 'never reached\\n'
`,
		);
		chmodSync(bin, 0o755);
		writeFileSync(
			join(dir, "agent.yaml"),
			`inference:
  defaultPolicy: dreaming
  targets:
    dreaming:
      executor: acpx
      acpx:
        agent: codex
        bin: ${bin}
        permissions: deny-all
        hooks: disabled
        terminal: false
      models:
        default:
          model: gpt-5.4-mini
  policies:
    dreaming:
      mode: strict
      defaultTargets:
        - dreaming/default
  workloads:
    memoryExtraction:
      policy: dreaming
`,
		);
		try {
			const router = getOrCreateInferenceRouter(dir);
			const startedAt = Date.now();
			const result = await router.runAgent(
				{ operation: "memory_extraction", promptPreview: "consolidate" },
				"Use the supplied evidence and daemon tools.",
				[],
				{
					timeoutMs: 200,
					acpxMcp: {
						agentId: "agent-deadline",
						passId: "pass-deadline",
						daemonUrl: "http://127.0.0.1:3850",
						authorizationToken: "scoped-agent-token",
					},
				},
			);
			const elapsed = Date.now() - startedAt;
			// The deadline is enforced: runAgent returned (no hang), failed the
			// attempt with a timeout/deadline message, and finished in bounded
			// time (the ACPX transport reports "timeout after Nms"; the
			// pi-agent session path reports "exceeded the Nms deadline").
			expect(elapsed).toBeLessThan(5_000);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(JSON.stringify(result.error)).toMatch(/timeout|deadline/i);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("isolates a rejected OAuth refresh from healthy fallback targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-oauth-refresh-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: auto
  accounts:
    revoked:
      kind: subscription_session
      providerFamily: ${REVOKED_OAUTH_PROVIDER_ID}
  targets:
    revoked:
      kind: subscription_session
      executor: ${REVOKED_OAUTH_PROVIDER_ID}
      account: revoked
      models:
        default:
          model: unavailable
    healthy:
      executor: openai-compatible
      endpoint: http://127.0.0.1:1234/v1
      models:
        default:
          model: healthy-local
  policies:
    auto:
      mode: automatic
      defaultTargets:
        - revoked/default
        - healthy/default
  workloads:
    interactive:
      policy: auto
`,
			);

			process.env.SIGNET_PATH = dir;
			invalidateSecretsCache();
			registerOAuthProviderForTests({
				id: REVOKED_OAUTH_PROVIDER_ID,
				name: "Revoked review OAuth",
				oauth: {
					name: "Revoked review OAuth",
					async login() {
						throw new Error("login not used");
					},
					async refresh() {
						throw new Error("revoked refresh token");
					},
					async toAuth(credentials) {
						return { apiKey: credentials.access };
					},
				},
			});
			await storeOAuthCredentials(REVOKED_OAUTH_PROVIDER_ID, {
				refresh: "refresh-revoked",
				access: "access-expired",
				expires: Date.now() - 1,
			});

			globalThis.fetch = mock((input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(openAiSseResponse("healthy fallback answer"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const status = await router.status(true);
			expect(status.ok).toBe(true);
			if (!status.ok) return;
			expect(status.value.runtimeSnapshot.targets["revoked/default"]?.accountState).toBe("expired");
			expect(status.value.runtimeSnapshot.targets["healthy/default"]?.accountState).toBe("ready");

			const result = await router.execute(
				{ operation: "interactive", promptPreview: "fallback after revoked OAuth" },
				"Answer through the healthy target",
				{ maxTokens: 64, timeoutMs: 1000 },
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("healthy fallback answer");
			expect(result.value.decision.targetRef).toBe("healthy/default");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("requires an explicit inference workload instead of compiling legacy pipeline routing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-no-legacy-routing-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: openrouter
      model: openai/gpt-4o-mini
      endpoint: https://openrouter.ai/api/v1
`,
			);

			const router = getOrCreateInferenceRouter(dir);
			expect(await router.hasWorkload("memory_extraction")).toBe(false);
			const result = await router.execute(
				{ operation: "memory_extraction", promptPreview: "must use the canonical workload" },
				"Do not infer a legacy route",
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("no-candidates");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes explicit OpenRouter reasoning controls through routed targets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-openrouter-reasoning-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: mercury
  accounts:
    openrouter-api:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
  targets:
    mercury:
      executor: openrouter
      account: openrouter-api
      openrouter:
        reasoning:
          enabled: false
          max_tokens: 0
      models:
        default:
          model: inception/mercury-2
          reasoning: medium
  policies:
    mercury:
      mode: automatic
      allow:
        - mercury/default
      defaultTargets:
        - mercury/default
  workloads:
    memoryExtraction:
      target: mercury/default
      taskClass: memory_extraction
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			let requestBody: Record<string, unknown> | null = null;
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/chat/completions") && typeof init?.body === "string") {
					const parsed: unknown = JSON.parse(init.body);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						requestBody = parsed as Record<string, unknown>;
					}
				}
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(openAiSseResponse("mercury answer"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{
					operation: "session_synthesis",
					promptPreview: "aggregate recall",
					expectedOutputTokens: 64,
				},
				"Summarize evidence",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.text).toBe("mercury answer");
			expect(result.value.decision.targetRef).toBe("mercury/default");
			// pi-ai owns the reasoning abstraction: the OpenRouter { enabled, maxTokens }
			// config is translated by pi-ai. With reasoning disabled (enabled: false),
			// pi-ai omits the reasoning field entirely rather than forwarding the raw config.
			expect(requestBody?.reasoning).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("forwards per-call reasoning effort when OpenRouter reasoning is enabled (#959)", async () => {
		// Regression guard for the reasoning fix: on `main`, the factory derived
		// reasoning from `=== "deep"` (TS2367, never matched) and pi-provider.ts
		// never forwarded options.reasoning, so thinking was always off. With the
		// fix, OpenRouter reasoning.enabled produces a non-disabled reasoning
		// effort on the wire. This model's current Pi catalog maps medium to no
		// wire value and supports high, so Pi correctly clamps it to high.
		const dir = mkdtempSync(join(tmpdir(), "signet-router-openrouter-reasoning-on-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: flash
  accounts:
    openrouter-api:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
  targets:
    flash:
      executor: openrouter
      account: openrouter-api
      openrouter:
        reasoning:
          enabled: true
      models:
        default:
          model: deepseek/deepseek-v4-flash
  policies:
    flash:
      mode: automatic
      allow:
        - flash/default
      defaultTargets:
        - flash/default
  workloads:
    memoryExtraction:
      target: flash/default
      taskClass: memory_extraction
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			let requestBody: Record<string, unknown> | null = null;
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/chat/completions") && typeof init?.body === "string") {
					const parsed: unknown = JSON.parse(init.body);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						requestBody = parsed as Record<string, unknown>;
					}
				}
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(openAiSseResponse("flash answer"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{ operation: "session_synthesis", promptPreview: "synthesize" },
				"Summarize",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			// The fix forwards options.reasoning; pi-ai's openrouter thinkingFormat
			// emits it as { effort: <level> }. Before the fix this was { effort: "none" }
			// (disabled) or absent.
			expect(requestBody?.reasoning).toEqual({ effort: "high" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not enable reasoning for a medium-depth model by default (#959)", async () => {
		// RoutingModelConfig.reasoning defaults to "medium" at parse time, so it
		// must NOT be treated as intent to emit thinking (would flip a costly
		// default on for every routed call). Only an explicit reasoning block or
		// a "high" depth enables thinking.
		const dir = mkdtempSync(join(tmpdir(), "signet-router-reasoning-medium-default-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: med
  accounts:
    openrouter-api:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
  targets:
    med:
      executor: openrouter
      account: openrouter-api
      models:
        default:
          model: openai/gpt-4o-mini
          # reasoning omitted -> parses to default "medium"
  policies:
    med:
      mode: automatic
      allow:
        - med/default
      defaultTargets:
        - med/default
  workloads:
    memoryExtraction:
      target: med/default
      taskClass: memory_extraction
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			let requestBody: Record<string, unknown> | null = null;
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/chat/completions") && typeof init?.body === "string") {
					const parsed: unknown = JSON.parse(init.body);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						requestBody = parsed as Record<string, unknown>;
					}
				}
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(openAiSseResponse("med answer"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{ operation: "session_synthesis", promptPreview: "synthesize" },
				"Summarize",
				{ maxTokens: 64, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			// Default "medium" depth must NOT enable thinking. pi-ai emits
			// { effort: "none" } (disabled) or omits — never "medium"/"high".
			const effort = (requestBody?.reasoning as { effort?: string } | undefined)?.effort;
			expect(effort === "medium" || effort === "high").toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("aggregate_recall suppresses reasoning even on a reasoning:high target (#959)", async () => {
		// aggregate_recall is latency-sensitive: it must never emit thinking tokens,
		// even when routed to a target explicitly configured reasoning: high. The
		// router passes reasoning:false at the call site (mirroring the ACPX
		// exclusion). Without this guard the fix would regress aggregate-recall
		// cost/latency whenever its workload target is a high-reasoning model.
		const dir = mkdtempSync(join(tmpdir(), "signet-router-aggregate-reasoning-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: deep
  accounts:
    openrouter-api:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
  targets:
    deep:
      executor: openrouter
      account: openrouter-api
      models:
        default:
          model: deepseek/deepseek-v4-flash
          reasoning: high
  policies:
    deep:
      mode: automatic
      allow:
        - deep/default
      defaultTargets:
        - deep/default
  workloads:
    aggregateRecall:
      target: deep/default
      taskClass: session_synthesis
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			let requestBody: Record<string, unknown> | null = null;
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/chat/completions") && typeof init?.body === "string") {
					const parsed: unknown = JSON.parse(init.body);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						requestBody = parsed as Record<string, unknown>;
					}
				}
				if (url.endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				return Promise.resolve(openAiSseResponse("aggregate answer"));
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const result = await router.execute(
				{ operation: "aggregate_recall", promptPreview: "what is signet" },
				"Synthesize",
				{ maxTokens: 300, timeoutMs: 1000 },
			);

			expect(result.ok).toBe(true);
			// The target is reasoning: high, but aggregate_recall must suppress it.
			// Acceptable wire shapes: reasoning absent, or { effort: "none" }.
			// A regression would emit { effort: "high" } or { effort: "medium" }.
			const effort = (requestBody?.reasoning as { effort?: string } | undefined)?.effort;
			expect(effort === "high" || effort === "medium").toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("InferenceRouter background quiescence", () => {
	it("aborts active routed inference and rejects new work until resumed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-quiescence-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: background
  accounts:
    openrouter-api:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY
  targets:
    background:
      executor: openrouter
      account: openrouter-api
      models:
        default:
          model: openai/gpt-4o-mini
    fallback:
      executor: openrouter
      account: openrouter-api
      models:
        default:
          model: openai/gpt-4o-mini
  policies:
    background:
      mode: automatic
      allow: [background/default, fallback/default]
      defaultTargets: [background/default, fallback/default]
  workloads:
    memoryExtraction:
      policy: background
      taskClass: memory_extraction
`,
			);

			process.env.OPENROUTER_API_KEY = "test-openrouter-key";
			let chatRequests = 0;
			let completeChat = false;
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith("/models")) {
					return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
				}
				chatRequests += 1;
				markStarted?.();
				if (completeChat) return Promise.resolve(openAiSseResponse("resumed answer"));
				return new Promise<Response>((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				});
			}) as unknown as typeof fetch;

			const router = getOrCreateInferenceRouter(dir);
			const active = router.execute({ operation: "memory_extraction", promptPreview: "extract" }, "Extract facts", {
				timeoutMs: 30_000,
			});
			await started;

			expect(await router.quiesceBackgroundInference(1_000)).toEqual({
				activeAtStart: 1,
				aborted: 1,
				remaining: 0,
				timedOut: false,
			});
			expect((await active).ok).toBe(false);
			expect(
				(await router.execute({ operation: "memory_extraction", promptPreview: "blocked" }, "Must not start")).ok,
			).toBe(false);
			expect(chatRequests).toBe(1);

			completeChat = true;
			router.resumeBackgroundInference();
			const resumed = await router.execute(
				{ operation: "memory_extraction", promptPreview: "resumed" },
				"Start after resume",
			);
			expect(resumed.ok).toBe(true);
			expect(chatRequests).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("InferenceRouter config reference validation (#1005)", () => {
	it("surfaces no configIssues for a fully-resolved config", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-valid-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: auto
  accounts:
    anthropic:
      kind: api
      providerFamily: anthropic
      credentialRef: ANTHROPIC_API_KEY
  targets:
    remote:
      executor: anthropic
      account: anthropic
      models:
        sonnet:
          model: claude-sonnet
  policies:
    auto:
      mode: automatic
      defaultTargets:
        - remote/sonnet
`,
			);
			const router = getOrCreateInferenceRouter(dir);
			await router.validateConfigReferences();
			const status = await router.status(true);
			expect(status.ok).toBe(true);
			if (!status.ok) return;
			expect(status.value.configIssues).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a config with dangling policy defaultTargets and surfaces them as warning configIssues", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-dangling-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: auto
  targets:
    real:
      executor: ollama
      models:
        default:
          model: gemma
  policies:
    auto:
      mode: automatic
      defaultTargets:
        - ghost/default
        - real/default
`,
			);
			const router = getOrCreateInferenceRouter(dir);
			const status = await router.status(true);
			expect(status.ok).toBe(true);
			if (!status.ok) return;
			const fields = status.value.configIssues.map((i) => i.field);
			expect(fields).toContain("policies.auto.defaultTargets");
			expect(status.value.configIssues.every((i) => i.severity === "warning")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns a structured invalid-config error from status when defaultPolicy points at a missing policy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-router-broken-"));
		try {
			mkdirSync(join(dir, "memory"), { recursive: true });
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  defaultPolicy: background-acpx
  targets:
    background:
      executor: acpx
      acpx:
        agent: codex
      models:
        default:
          model: gpt
  policies:
    background:
      mode: automatic
      defaultTargets:
        - background/default
`,
			);
			const router = getOrCreateInferenceRouter(dir);
			// Boot validation must not throw; it logs the structured error.
			await router.validateConfigReferences();
			const status = await router.status(true);
			expect(status.ok).toBe(false);
			if (status.ok) return;
			expect(status.error.code).toBe("invalid-config");
			expect(status.error.message).toContain('defaultPolicy="background-acpx"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
