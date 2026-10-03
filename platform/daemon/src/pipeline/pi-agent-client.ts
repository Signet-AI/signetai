import { resolveRuntimeAsset } from "@signet/core";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";
import type { PiAgentSession } from "./pi-provider";
import { PI_AGENT_MAX_MESSAGE_BYTES, PI_AGENT_MAX_WORKERS } from "./pi-agent-protocol";
import type { PiAgentTool, PiAgentWorkerInput, PiAgentWorkerRequest, PiAgentWorkerResponse } from "./pi-agent-protocol";

const workers = new Set<Worker>();
let accepting = true;
const disposers = new Map<Worker, () => Promise<void>>();
export async function stopPiAgentWorkers(closeAdmission = false): Promise<void> {
	if (closeAdmission) accepting = false;
	for (const entry of persistentSessions.values()) clearTimeout(entry.timer);
	persistentSessions.clear();
	await Promise.all([...disposers.values()].map((dispose) => dispose()));
}
export function activePiAgentWorkers(): number {
	return workers.size;
}

export async function createWorkerAgentSession(
	input: PiAgentWorkerInput,
	tools: readonly PiAgentTool[],
	signal?: AbortSignal,
): Promise<PiAgentSession> {
	if (!accepting) throw new Error("Pi agent worker admission closed");
	if (signal?.aborted) throw new Error("Pi agent initialization cancelled");
	if (workers.size >= PI_AGENT_MAX_WORKERS) throw new Error("Pi agent worker capacity reached");
	if (Buffer.byteLength(JSON.stringify(input)) > PI_AGENT_MAX_MESSAGE_BYTES)
		throw new Error("Pi agent input limit exceeded");
	const worker = new Worker(
		resolveEmbeddedWorkerPath("pi-agent-worker") ?? resolveRuntimeAsset("pi-agent-worker.js", import.meta.url),
		{ workerData: JSON.parse(JSON.stringify(input)) },
	);
	workers.add(worker);
	let controller = new AbortController();
	let activeTools = tools;
	let activeModel = input.model;
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const toolCalls = new Set<Promise<void>>();
	let stats: SessionStats | undefined;
	let usages: readonly Usage[] | undefined;
	let failure: string | undefined;
	let sessionId = "";
	let executionThreadId = 0;
	let disposed = false;
	let prompt: { resolve: () => void; reject: (error: Error) => void } | undefined;
	let readyResolve: () => void = () => {};
	let readyReject: (error: Error) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const send = (message: PiAgentWorkerRequest) => {
		if (disposed) throw new Error("Pi agent worker closed");
		if (Buffer.byteLength(JSON.stringify(message)) > PI_AGENT_MAX_MESSAGE_BYTES)
			throw new Error("Pi agent message limit exceeded");
		worker.postMessage(message);
	};
	const fail = (error: Error) => {
		failure = error.message;
		readyReject(error);
		prompt?.reject(error);
		prompt = undefined;
		controller.abort(error);
	};
	worker.on("message", (message: PiAgentWorkerResponse) => {
		if (disposed) return;
		if (message.type === "ready") {
			sessionId = message.sessionId;
			executionThreadId = message.threadId;
			readyResolve();
		}
		if (message.type === "event") {
			try {
				for (const listener of listeners) listener(message.event);
			} catch (error) {
				fail(error instanceof Error ? error : new Error("Pi event observer failed"));
				void dispose();
			}
		}
		if (message.type === "error") fail(new Error(message.message));
		if (message.type === "complete") {
			stats = message.stats;
			usages = message.usages;
			failure = message.failure;
			prompt?.resolve();
			prompt = undefined;
		}
		if (message.type === "tool") {
			const call = (async () => {
				try {
					const tool = activeTools.find((item) => item.name === message.name);
					if (!tool) throw new Error("Unknown Pi agent tool");
					const result = await tool.execute(message.toolCallId, message.params, controller.signal);
					if (!disposed) send({ type: "tool-result", id: message.id, result });
				} catch (error) {
					if (!disposed)
						send({
							type: "tool-result",
							id: message.id,
							error: error instanceof Error ? error.message.slice(0, 8192) : "Tool failed",
						});
				}
			})();
			toolCalls.add(call);
			void call.then(
				() => toolCalls.delete(call),
				(error: unknown) => {
					toolCalls.delete(call);
					fail(error instanceof Error ? error : new Error("Pi tool transport failed"));
					void dispose();
				},
			);
		}
	});
	worker.on("error", fail);
	worker.on("exit", (code) => {
		workers.delete(worker);
		disposed = true;
		fail(new Error(`Pi agent worker exited (${code})`));
	});
	let disposal: Promise<void> | undefined;
	const dispose = () =>
		(disposal ??= (async () => {
			disposed = true;
			fail(new Error("Pi agent session closed"));
			listeners.clear();
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout>;
				const finish = () => {
					clearTimeout(timer);
					worker.off("message", acknowledged);
					worker.off("exit", finish);
					resolve();
				};
				const acknowledged = (message: PiAgentWorkerResponse) => {
					if (message.type === "aborted") finish();
				};
				timer = setTimeout(finish, 1000);
				worker.on("message", acknowledged);
				worker.once("exit", finish);
				worker.postMessage({ type: "abort" });
			});
			await worker.terminate();
			await Promise.allSettled(toolCalls);
			workers.delete(worker);
			disposers.delete(worker);
		})());
	disposers.set(worker, dispose);
	const cancelInitialization = () => {
		void dispose();
	};
	signal?.addEventListener("abort", cancelInitialization, { once: true });
	const initializationDeadline = setTimeout(() => {
		void dispose();
	}, 15_000);
	try {
		await ready;
	} catch (error) {
		await dispose();
		throw error;
	} finally {
		clearTimeout(initializationDeadline);
		signal?.removeEventListener("abort", cancelInitialization);
	}
	return {
		async prompt(text) {
			if (prompt || disposed) throw new Error("Pi agent session unavailable");
			controller = new AbortController();
			failure = undefined;
			await new Promise<void>((resolve, reject) => {
				prompt = { resolve, reject };
				try {
					send({ type: "prompt", text });
				} catch (error) {
					prompt = undefined;
					reject(error);
				}
			});
		},

		async updateModel(next) {
			if (prompt || disposed) throw new Error("Pi agent session unavailable");
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					worker.off("message", acknowledge);
					reject(new Error("Pi model switch timed out"));
				}, 5000);
				const acknowledge = (message: PiAgentWorkerResponse) => {
					if (message.type !== "configured" && message.type !== "error") return;
					clearTimeout(timer);
					worker.off("message", acknowledge);
					if (message.type === "error") reject(new Error(message.message));
					else resolve();
				};
				worker.on("message", acknowledge);
				send({ type: "configure", ...next });
			});
			activeModel = next.model;
		},
		setTools(nextTools) {
			if (prompt || disposed) throw new Error("Pi agent session unavailable");
			activeTools = nextTools;
		},
		async cancelTurn() {
			controller.abort(new Error("Pi agent turn cancelled"));
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					worker.off("message", acknowledge);
					reject(new Error("Pi agent cancellation timed out"));
				}, 1000);
				const acknowledge = (message: PiAgentWorkerResponse) => {
					if (message.type !== "aborted") return;
					clearTimeout(timer);
					worker.off("message", acknowledge);
					resolve();
				};
				worker.on("message", acknowledge);
				send({ type: "cancel" });
			});
			await Promise.allSettled(toolCalls);
		},
		abort: dispose,
		dispose,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSystemPrompt: () => input.systemPrompt,
		getSessionId: () => sessionId,
		getModelName: () => activeModel.id,
		getActiveToolNames: () => activeTools.map((tool) => tool.name),
		getExecutionThreadId: () => executionThreadId,
		getStats: () => stats,
		getRequestUsages: () => usages,
		getFailureMessage: () => failure,
	};
}

export const PI_CHAT_IDLE_TTL_MS = 15 * 60 * 1000;
const persistentSessions = new Map<
	string,
	{
		session: Promise<PiAgentSession>;
		signature: string;
		modelSignature: string;
		apiKey: string;
		busy: boolean;
		timer?: ReturnType<typeof setTimeout>;
	}
>();

export async function leaseWorkerAgentSession(
	key: string,
	continuationPrompt: string | undefined,
	input: PiAgentWorkerInput,
	tools: readonly PiAgentTool[],
	signal?: AbortSignal,
	idleTtlMs = PI_CHAT_IDLE_TTL_MS,
): Promise<PiAgentSession> {
	if (!accepting || signal?.aborted) throw new Error("Pi agent session admission unavailable");
	const signature = createHash("sha256")
		.update(JSON.stringify({ tools: input.tools, systemPrompt: input.systemPrompt }))
		.digest("hex");
	const modelSignature = createHash("sha256").update(JSON.stringify(input.model)).digest("hex");
	let entry = persistentSessions.get(key);
	if (entry?.busy) throw new Error("This conversation already has an active turn");
	if (entry && entry.signature !== signature) {
		clearTimeout(entry.timer);
		entry.busy = true;
		await (await entry.session).dispose();
		persistentSessions.delete(key);
		entry = undefined;
	}
	const resumed = entry !== undefined;
	if (!entry) {
		if (persistentSessions.size >= 3)
			throw new Error("Persistent chat capacity reached; idle sessions expire after 15 minutes");
		entry = {
			session: createWorkerAgentSession(input, tools, signal),
			signature,
			modelSignature,
			apiKey: input.apiKey,
			busy: true,
		};
		persistentSessions.set(key, entry);
	} else {
		clearTimeout(entry.timer);
		entry.busy = true;
	}
	const current = entry;
	let session: PiAgentSession;
	try {
		session = await current.session;
		if (current.modelSignature !== modelSignature || current.apiKey !== input.apiKey) {
			await session.updateModel?.(input);
			current.modelSignature = modelSignature;
			current.apiKey = input.apiKey;
		}
		session.setTools?.(tools);
	} catch (error) {
		persistentSessions.delete(key);
		await (await current.session.catch(() => undefined))?.dispose();
		throw error;
	}
	let released = false;
	return {
		...session,
		prompt: (text) => session.prompt(resumed && continuationPrompt !== undefined ? continuationPrompt : text),
		async abort() {
			try {
				await session.cancelTurn?.();
			} catch (error) {
				persistentSessions.delete(key);
				await session.dispose();
				throw error;
			}
		},
		dispose() {
			if (released) return;
			released = true;
			current.busy = false;
			try {
				session.setTools?.([]);
			} catch {
				persistentSessions.delete(key);
				return session.dispose();
			}
			if (persistentSessions.get(key) !== current) return;
			current.timer = setTimeout(() => {
				persistentSessions.delete(key);
				void session.dispose();
			}, idleTtlMs);
			current.timer.unref();
		},
	};
}
