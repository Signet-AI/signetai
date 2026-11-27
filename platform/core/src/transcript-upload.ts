import { attempt } from "./attempt";

export const MAX_INLINE_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_UPLOAD_BYTES = 1024 * 1024;
export const TRANSCRIPT_UPLOAD_TAIL_BYTES = 64 * 1024;
const TRANSCRIPT_UPLOAD_PATH = "/api/hooks/transcript-upload";
const MAX_UPLOAD_PLANS = 3;
const MAX_UPLOAD_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 5000;

export interface TranscriptSource {
	readonly size: number;
	read(start: number, end: number): Promise<Uint8Array<ArrayBuffer>>;
}

export interface TranscriptUploadTarget {
	readonly harness: string;
	readonly sessionKey: string;
	readonly agentId?: string;
	readonly cwd?: string;
}

export interface TranscriptUploadClient {
	readonly baseUrl: string;
	readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly retryDelayMs?: number;
	readonly signal?: AbortSignal;
}

export type TranscriptUploadOutcome =
	| { readonly status: "uploaded"; readonly committedOffset: number; readonly generation: number }
	| { readonly status: "unchanged" | "bypassed" | "unsupported" };

export class TranscriptUploadError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "TranscriptUploadError";
	}
}

export interface TranscriptUploadStatus {
	readonly committedOffset: number;
	readonly generation: number | null;
	readonly tailSha256: string | null;
}

export interface TranscriptUploadPlan {
	readonly generation: number;
	readonly offset: number;
	readonly end: number;
}

export interface TranscriptUploadRange {
	readonly start: number;
	readonly end: number;
}

export function transcriptUploadTailStart(end: number): number {
	return Math.max(0, end - TRANSCRIPT_UPLOAD_TAIL_BYTES);
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function transcriptUploadEnd(bytes: Uint8Array): number {
	return bytes.lastIndexOf(0x0a) + 1;
}

export function transcriptUploadRanges(offset: number, end: number): readonly TranscriptUploadRange[] {
	const ranges: TranscriptUploadRange[] = [];
	for (let start = offset; start < end; start += MAX_TRANSCRIPT_UPLOAD_BYTES) {
		ranges.push({ start, end: Math.min(end, start + MAX_TRANSCRIPT_UPLOAD_BYTES) });
	}
	return ranges;
}

export async function transcriptSourceEnd(source: TranscriptSource, floor: number): Promise<number> {
	for (let end = source.size; end > floor; end -= TRANSCRIPT_UPLOAD_TAIL_BYTES) {
		const start = Math.max(floor, end - TRANSCRIPT_UPLOAD_TAIL_BYTES);
		const found = transcriptUploadEnd(await source.read(start, end));
		if (found > 0) return start + found;
	}
	return floor;
}

export async function transcriptUploadPlan(
	state: TranscriptUploadStatus,
	source: TranscriptSource,
): Promise<TranscriptUploadPlan> {
	const offset = state.committedOffset;
	if (state.generation !== null && offset <= source.size) {
		const tail = await source.read(transcriptUploadTailStart(offset), offset);
		if ((await sha256Hex(tail)) === state.tailSha256) {
			return { generation: state.generation, offset, end: await transcriptSourceEnd(source, offset) };
		}
	}
	const generation = state.generation === null ? 0 : state.generation + 1;
	return { generation, offset: 0, end: await transcriptSourceEnd(source, 0) };
}

export async function uploadTranscript(
	client: TranscriptUploadClient,
	target: TranscriptUploadTarget,
	source: TranscriptSource,
): Promise<TranscriptUploadOutcome> {
	const url = transcriptUploadUrl(client.baseUrl, target);
	const answer = await fetchWithRetry(client, url, { method: "GET", headers: client.headers });
	if (answer.status === 404) {
		await answer.body?.cancel();
		return { status: "unsupported" };
	}
	let state = transcriptUploadStatus(await readAnswer(answer));
	for (let plans = 1; ; plans++) {
		const plan = await transcriptUploadPlan(state, source);
		if (plan.offset >= plan.end) return { status: "unchanged" };
		const sent = await sendRanges(client, url, source, plan);
		if (sent.status !== "conflict") return sent;
		if (plans >= MAX_UPLOAD_PLANS) {
			throw new TranscriptUploadError(409, `transcript upload still conflicts after ${plans} plans`);
		}
		state = sent.state;
	}
}

type RangesResult = TranscriptUploadOutcome | { readonly status: "conflict"; readonly state: TranscriptUploadStatus };

async function sendRanges(
	client: TranscriptUploadClient,
	url: string,
	source: TranscriptSource,
	plan: TranscriptUploadPlan,
): Promise<RangesResult> {
	let committedOffset = plan.offset;
	for (const range of transcriptUploadRanges(plan.offset, plan.end)) {
		const response = await sendRange(
			client,
			url,
			plan.generation,
			range.start,
			await source.read(range.start, range.end),
		);
		const answer = await readAnswer(response);
		if (response.status === 409) return { status: "conflict", state: transcriptUploadStatus(answer) };
		if (isRecord(answer) && answer.bypassed === true) return { status: "bypassed" };
		committedOffset = transcriptUploadStatus(answer).committedOffset;
	}
	return { status: "uploaded", committedOffset, generation: plan.generation };
}

async function sendRange(
	client: TranscriptUploadClient,
	url: string,
	generation: number,
	offset: number,
	body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
	const headers = {
		...client.headers,
		"Content-Type": "application/octet-stream",
		"Upload-Generation": String(generation),
		"Upload-Offset": String(offset),
		"Upload-Checksum": await sha256Hex(body),
	};
	return await fetchWithRetry(client, url, { method: "PATCH", headers, body });
}

async function fetchWithRetry(client: TranscriptUploadClient, url: string, init: RequestInit): Promise<Response> {
	for (let tries = 1; ; tries++) {
		const response = await client.fetch(url, { ...init, signal: client.signal });
		if (response.status !== 503 || tries >= MAX_UPLOAD_ATTEMPTS) return response;
		await response.body?.cancel();
		await wait(retryAfterMs(response) ?? client.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, client.signal);
	}
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("Retry-After");
	const seconds = header === null ? Number.NaN : Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : undefined;
}

function transcriptUploadUrl(baseUrl: string, target: TranscriptUploadTarget): string {
	const url = new URL(`${baseUrl.replace(/\/+$/, "")}${TRANSCRIPT_UPLOAD_PATH}`);
	url.searchParams.set("harness", target.harness);
	url.searchParams.set("sessionKey", target.sessionKey);
	if (target.agentId) url.searchParams.set("agentId", target.agentId);
	if (target.cwd) url.searchParams.set("cwd", target.cwd);
	return url.toString();
}

async function readAnswer(response: Response): Promise<unknown> {
	const text = await response.text();
	const body: unknown = attempt(() => JSON.parse(text));
	const conflict = response.status === 409 && isRecord(body) && body.error === "offset_mismatch";
	if (response.ok || conflict) return body;
	const reason = isRecord(body) && typeof body.error === "string" ? body.error : text.slice(0, 200);
	throw new TranscriptUploadError(response.status, `transcript upload failed with HTTP ${response.status}: ${reason}`);
}

function transcriptUploadStatus(body: unknown): TranscriptUploadStatus {
	if (
		isRecord(body) &&
		typeof body.committedOffset === "number" &&
		isNumberOrNull(body.generation) &&
		isStringOrNull(body.tailSha256)
	) {
		return { committedOffset: body.committedOffset, generation: body.generation, tailSha256: body.tailSha256 };
	}
	throw new TranscriptUploadError(502, "the daemon sent an invalid transcript upload state");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNumberOrNull(value: unknown): value is number | null {
	return value === null || typeof value === "number";
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}
