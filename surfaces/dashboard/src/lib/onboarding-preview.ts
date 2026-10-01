import { parse } from "yaml";
import { installDemoApi } from "./demo";
import type { ConfigFile, HarnessSummary, SourceImportsResponse } from "./api";

type ApiClient = typeof import("./api").api;
let config = "harnesses: []\nmemory:\n  dreaming:\n    enabled: true\n";
let memory: Record<string, unknown> | null = null;
const identityFiles = new Map<string, string>();
const configFiles = (): ConfigFile[] => [
	{ name: "agent.yaml", content: config, size: config.length },
	...Array.from(identityFiles, ([name, content]) => ({ name, content, size: content.length })),
];

const previewHarnesses: HarnessSummary[] = [
	["claude-code", "Claude Code", "claude.svg"],
	["codex", "Codex", "openai.svg"],
	["hermes-agent", "Hermes Agent", "hermes-agent.svg"],
	["opencode", "OpenCode", "opencode.svg"],
	["openclaw", "OpenClaw", "openclaw.svg"],
	["gemini", "Gemini", "gemini.svg"],
	["pi", "pi", "pi.svg"],
	["oh-my-pi", "Oh My Pi", "oh-my-pi.svg"],
	["kimi", "Kimi", "kimi.png"],
	["forge", "ForgeCode", "forge.svg"],
].map(([id, name, icon]) => ({ id, name, icon, path: "preview", exists: false, lastSeen: null }));

export function installOnboardingPreview(target: ApiClient): void {
	installDemoApi(target);
	target.getHarnesses = async () => ({
		data: { harnesses: previewHarnesses, connectors: [], configuredHarnesses: [] },
		error: null,
	});
	target.getConfigFiles = async () => configFiles();
	target.getStatus = async () => ({
		status: "running",
		version: "preview",
		uptime: 0,
		port: 0,
		host: "localhost",
		bindHost: "localhost",
		networkMode: "local",
		agentId: "onboarding-preview",
		agentsDir: "preview",
	});
}

export async function onboardingPreviewFetch(path: string, init?: RequestInit): Promise<Response> {
	init?.signal?.throwIfAborted();
	const url = new URL(path, "http://preview.invalid");
	const route = url.pathname;
	const method = init?.method ?? "GET";
	const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
	if (route === "/api/config") {
		if (method === "GET") return Response.json({ files: configFiles() });
		if (typeof body.content !== "string") return Response.json({ error: "Invalid preview config" }, { status: 400 });
		if (body.file === "agent.yaml") config = body.content;
		else if (typeof body.file === "string" && /^[A-Z]+\.md$/.test(body.file))
			identityFiles.set(body.file, body.content);
		else return Response.json({ error: "Invalid preview file" }, { status: 400 });
		return Response.json({ success: true });
	}
	if (/^\/api\/harnesses\/[^/]+\/connect$/.test(route)) return Response.json({ success: true });
	if (route === "/api/embeddings/status" && method === "GET") {
		const embedding = parse(config)?.embedding ?? {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
		};
		return Response.json({
			...embedding,
			available: embedding.provider !== "none",
			checkedAt: new Date().toISOString(),
		});
	}
	if (route === "/api/inference/catalog")
		return Response.json({
			providers: ["openai-codex", "openai-compatible"],
			models: {
				"openai-codex": [
					{ id: "preview-model", name: "Preview model", contextWindow: 128000, input: ["text"], reasoning: false },
				],
			},
			recommendedModels: { "openai-codex": "preview-model", "openai-compatible": "preview-model" },
			modelErrors: {},
			oauthProviders: [{ id: "openai-codex", name: "ChatGPT / Codex", usesCallbackServer: false, connected: false }],
			acpxAgents: [],
		});
	if (route.startsWith("/api/inference/oauth/login/"))
		return new Response('data: {"type":"connected"}\n\n', {
			headers: { "Content-Type": "text/event-stream", "X-Signet-OAuth-Session-Id": "preview" },
		});
	if (route.startsWith("/api/secrets/") || route === "/api/inference/oauth/cancel")
		return Response.json({ success: true });
	if (route === "/api/inference/execute")
		return Response.json({ text: "OK", attempts: [{ ok: true }], decision: { targetRef: "background/default" } });
	if (route === "/api/pipeline/resume") return Response.json({ success: true, mode: "controlled-write" });
	if (route === "/api/memory/remember") {
		memory = { ...body, id: "preview-memory", type: "fact", tags: "onboarding", created_at: new Date().toISOString() };
		return Response.json({ id: "preview-memory" });
	}
	if (route === "/memory/search") return Response.json({ results: memory ? [memory] : [] });
	if (route === "/api/sources/imports") return Response.json({ imports: [] } satisfies SourceImportsResponse);
	return Response.json({ error: "This action is not simulated in onboarding preview." }, { status: 501 });
}
