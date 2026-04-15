/**
 * Shared message types and type guards for the synthesis render worker
 * thread protocol. Imported by both the worker script and the host
 * (hooks.ts, daemon.ts) so message shape changes produce compile errors
 * on both sides.
 */

// ---------------------------------------------------------------------------
// Request types (host → worker)
// ---------------------------------------------------------------------------

export type InitRequest = {
	readonly type: "init";
	readonly dbPath: string;
	readonly vecExtensionPath: string;
};

export type RenderRequest = {
	readonly type: "render";
	readonly agentId: string;
	readonly requestId: string;
};

export type WorkerRequest = InitRequest | RenderRequest;

// ---------------------------------------------------------------------------
// Response types (worker → host)
// ---------------------------------------------------------------------------

export type ReadyResponse = {
	readonly type: "ready";
};

export type RenderResult = {
	readonly type: "result";
	readonly requestId: string;
	readonly content: string;
	readonly fileCount: number;
	readonly indexBlock: string;
};

export type RenderError = {
	readonly type: "error";
	readonly requestId: string;
	readonly error: string;
};

export type WorkerResponse = ReadyResponse | RenderResult | RenderError;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isInitRequest(value: unknown): value is InitRequest {
	if (!isObject(value)) return false;
	return (
		value.type === "init" &&
		typeof value.dbPath === "string" &&
		typeof value.vecExtensionPath === "string"
	);
}

export function isRenderRequest(value: unknown): value is RenderRequest {
	if (!isObject(value)) return false;
	return (
		value.type === "render" &&
		typeof value.agentId === "string" &&
		typeof value.requestId === "string"
	);
}

export function isReadyResponse(value: unknown): value is ReadyResponse {
	if (!isObject(value)) return false;
	return value.type === "ready";
}

export function isRenderResult(value: unknown): value is RenderResult {
	if (!isObject(value)) return false;
	return (
		value.type === "result" &&
		typeof value.requestId === "string" &&
		typeof value.content === "string" &&
		typeof value.fileCount === "number" &&
		typeof value.indexBlock === "string"
	);
}

export function isRenderError(value: unknown): value is RenderError {
	if (!isObject(value)) return false;
	return (
		value.type === "error" &&
		typeof value.requestId === "string" &&
		typeof value.error === "string"
	);
}
