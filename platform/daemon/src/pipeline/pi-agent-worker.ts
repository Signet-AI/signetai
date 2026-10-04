import { parentPort, workerData, threadId } from "node:worker_threads";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PI_AGENT_MAX_MESSAGE_BYTES } from "./pi-agent-protocol";
import type { PiAgentWorkerInput, PiAgentWorkerRequest, PiAgentWorkerResponse } from "./pi-agent-protocol";

const port = parentPort;
if (!port) throw new Error("Pi agent execution requires a worker thread");
const input: PiAgentWorkerInput = workerData;
const send = (message: PiAgentWorkerResponse) => {
	if (Buffer.byteLength(JSON.stringify(message)) > PI_AGENT_MAX_MESSAGE_BYTES)
		throw new Error("Pi agent message limit exceeded");
	port.postMessage(message);
};
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
runtime.registerProvider(input.model.provider, {
	name: input.model.provider,
	baseUrl: input.model.baseUrl,
	api: input.model.api,
	apiKey: input.apiKey,
	models: [{ ...input.model }],
});
const settingsManager = SettingsManager.inMemory(input.retry ? { retry: { enabled: true, ...input.retry } } : {});
const resourceLoader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: process.cwd(),
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	systemPrompt: input.systemPrompt,
});
await resourceLoader.reload();
let nextId = 0;
let toolCount = 0;
const pending = new Map<
	number,
	{ resolve: (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => void; reject: (error: Error) => void }
>();
const customTools: ToolDefinition[] = input.tools.map((tool) => ({
	...tool,
	execute(toolCallId, params) {
		return new Promise((resolve, reject) => {
			if (++toolCount > 64 || pending.size >= 8) {
				reject(new Error("Pi agent tool budget exceeded"));
				return;
			}
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			send({ type: "tool", id, name: tool.name, toolCallId, params });
		});
	},
}));
const { session } = await createAgentSession({
	model: input.model,
	modelRuntime: runtime,
	sessionManager: SessionManager.inMemory(),
	settingsManager,
	resourceLoader,
	tools: customTools.map((tool) => tool.name),
	customTools,
});
session.subscribe((event) => send({ type: "event", event }));
let running = false;
port.on("message", async (request: PiAgentWorkerRequest) => {
	try {
		if (Buffer.byteLength(JSON.stringify(request)) > PI_AGENT_MAX_MESSAGE_BYTES)
			throw new Error("Pi agent request limit exceeded");
		if (request.type === "configure") {
			if (running) throw new Error("Cannot switch models during an active turn");
			runtime.registerProvider(request.model.provider, {
				name: request.model.provider,
				baseUrl: request.model.baseUrl,
				api: request.model.api,
				apiKey: request.apiKey,
				models: [{ ...request.model }],
			});
			await session.setModel(request.model);
			send({ type: "configured" });
			return;
		}
		if (request.type === "tool-result") {
			const call = pending.get(request.id);
			pending.delete(request.id);
			if (request.error) call?.reject(new Error(request.error));
			else if (request.result) call?.resolve(request.result);
			else call?.reject(new Error("Missing tool result"));
			return;
		}
		if (request.type === "abort" || request.type === "cancel") {
			for (const call of pending.values()) call.reject(new Error("Pi agent aborted"));
			pending.clear();
			await session.abort();
			send({ type: "aborted" });
			return;
		}
		if (running) throw new Error("Pi agent session already running");
		running = true;
		toolCount = 0;
		const previousStats = session.getSessionStats();
		const firstMessage = session.messages.length;
		try {
			await session.prompt(request.text);
			const messages = session.messages.slice(firstMessage).filter((message) => message.role === "assistant");
			const last = messages[messages.length - 1];
			send({
				type: "complete",
				stats: (() => {
					const stats = session.getSessionStats();
					return {
						...stats,
						cost: stats.cost - previousStats.cost,
						tokens: {
							input: stats.tokens.input - previousStats.tokens.input,
							output: stats.tokens.output - previousStats.tokens.output,
							cacheRead: stats.tokens.cacheRead - previousStats.tokens.cacheRead,
							cacheWrite: stats.tokens.cacheWrite - previousStats.tokens.cacheWrite,
							total: stats.tokens.total - previousStats.tokens.total,
						},
					};
				})(),
				usages: messages.map((message) => message.usage),
				failure:
					last && ["error", "aborted", "length"].includes(last.stopReason)
						? (last.errorMessage ?? `Pi agent ${last.stopReason}`)
						: undefined,
			});
		} finally {
			running = false;
		}
	} catch (error) {
		send({ type: "error", message: error instanceof Error ? error.message : "Pi agent failed" });
	}
});
send({ type: "ready", sessionId: session.sessionId, threadId });
