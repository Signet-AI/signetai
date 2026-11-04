import {
	type DaemonClient,
	type DaemonRequestClient,
	type PeerContext,
	PeerContextTracker,
	boundResources,
	boundTask,
	readTrimmedString,
} from "@signet/pi-extension-base";
import { currentSessionRef } from "./lifecycle.js";
import { HARNESS, type PiExtensionContext, RUNTIME_PATH, WRITE_TIMEOUT } from "./types.js";

export interface ContextUpdate {
	readonly task?: string;
	readonly resources?: unknown;
}

export interface PeerContextController {
	contextFor(ctx: PiExtensionContext): PeerContext | undefined;
	latest(): PeerContext | undefined;
	recordMutation(ctx: PiExtensionContext, toolName: string, input: unknown): void;
	publish(ctx: PiExtensionContext, force?: boolean, signal?: AbortSignal): Promise<boolean>;
	update(ctx: PiExtensionContext, update: ContextUpdate, signal?: AbortSignal): Promise<UpdateOutcome>;
	forget(sessionId: string | undefined): void;
}

export type UpdateOutcome =
	| { readonly ok: true; readonly context: PeerContext; readonly presence?: unknown }
	| { readonly ok: false; readonly error: string };

export function createPeerContextController(
	client: DaemonClient & DaemonRequestClient,
	agentId: string | undefined,
): PeerContextController {
	const tracker = new PeerContextTracker();
	const lastPublished = new Map<string, string>();
	let chain: Promise<unknown> = Promise.resolve();
	let latestCtx: PiExtensionContext | undefined;

	const contextFor = (ctx: PiExtensionContext): PeerContext | undefined => {
		latestCtx = ctx;
		const session = currentSessionRef(ctx);
		const name = readTrimmedString(ctx.sessionManager.getSessionName?.());
		return tracker.snapshot(session.sessionId, { cwd: session.project, title: name });
	};

	async function post(
		ctx: PiExtensionContext,
		context: PeerContext,
		signal?: AbortSignal,
	): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
		const session = currentSessionRef(ctx);
		if (!session.sessionId) return { ok: false, error: "no active session" };
		const result = await client.postResult<{ presence?: unknown }>(
			"/api/cross-agent/presence",
			{
				harness: HARNESS,
				runtimePath: RUNTIME_PATH,
				agentId,
				sessionKey: session.sessionId,
				project: session.project,
				context,
			},
			WRITE_TIMEOUT,
			signal,
		);
		if (!result.ok) {
			const status = result.status !== undefined ? ` (HTTP ${result.status})` : "";
			return { ok: false, error: `${result.reason}${status}${result.detail ? `: ${result.detail}` : ""}` };
		}
		return { ok: true, data: result.data };
	}

	return {
		contextFor,
		latest() {
			if (!latestCtx) return undefined;
			try {
				return contextFor(latestCtx);
			} catch {
				return undefined;
			}
		},
		recordMutation(ctx, toolName, input) {
			const session = currentSessionRef(ctx);
			if (!session.sessionId) return;
			if (!tracker.recordMutation(session.sessionId, toolName, input, session.project)) return;
			chain = chain.then(() => this.publish(ctx)).catch(() => undefined);
		},
		async publish(ctx, force = false, signal) {
			const context = contextFor(ctx);
			const sessionId = currentSessionRef(ctx).sessionId;
			if (!context || !sessionId) return false;
			const key = JSON.stringify(context);
			if (!force && lastPublished.get(sessionId) === key) return true;
			const sent = await post(ctx, context, signal);
			if (sent.ok) lastPublished.set(sessionId, key);
			return sent.ok;
		},
		async update(ctx, update, signal) {
			const sessionId = currentSessionRef(ctx).sessionId;
			if (!sessionId) return { ok: false, error: "no active session" };
			const explicitTask = typeof update.task === "string" ? update.task : undefined;
			const resources = boundResources(update.resources);
			if (explicitTask === undefined && resources === undefined) {
				return { ok: false, error: "provide task and/or resources (an empty list clears resources)" };
			}
			if (explicitTask !== undefined) tracker.setTask(sessionId, boundTask(explicitTask));
			if (resources !== undefined) tracker.setResources(sessionId, resources);
			const context = contextFor(ctx);
			if (!context) return { ok: false, error: "no context available" };
			const body: PeerContext = explicitTask !== undefined && !context.task ? { ...context, task: "" } : context;
			const sent = await post(ctx, body, signal);
			if (!sent.ok) return { ok: false, error: sent.error };
			lastPublished.set(sessionId, JSON.stringify(context));
			const presence = (sent.data as { presence?: unknown } | null)?.presence;
			return { ok: true, context: body, presence };
		},
		forget(sessionId) {
			tracker.forget(sessionId);
			if (sessionId) lastPublished.delete(sessionId);
		},
	};
}
