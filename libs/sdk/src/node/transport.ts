import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { randomUUID } from "node:crypto";
import {
	SignetError,
	SignetApiError,
	SignetCredentialError,
	SignetNetworkError,
	SignetTimeoutError,
	SignetUnauthorizedError,
} from "../errors.js";
import { SignetClient } from "../index.js";
import { abortable, requestSignal, SignetTransport, type RequestOptions, type TransportConfig } from "../transport.js";
import {
	DurableOutbox,
	deliveryPath,
	captureDeliveryHeaders,
	DELIVERY_SCOPE_HEADERS,
	type FlushOptions,
	type UploadCheckpoint,
	type OutboxEntry,
	type OutboxFlushResult,
} from "./outbox.js";
import type { ResolvedTarget } from "./target.js";
import { captureRemoteSessionEnd } from "./capture.js";
import type { StorageOptions } from "./storage.js";

export interface NodeTransportOptions
	extends StorageOptions,
		Omit<TransportConfig, "baseUrl" | "credentialProvider" | "cookieAuth"> {
	readonly deliveryPaths?: readonly string[];
}
export class NodeTransport extends SignetTransport {
	readonly outbox: DurableOutbox;
	private readonly deliveryPaths: ReadonlySet<string>;
	private readonly options: Omit<NodeTransportOptions, "env">;
	constructor(
		private readonly target: ResolvedTarget,
		options: NodeTransportOptions = {},
	) {
		const { env, ...runtimeOptions } = options;
		super({ ...runtimeOptions, baseUrl: target.url });
		this.options = runtimeOptions;
		if (new URL(target.url).origin !== target.origin) throw new Error("Target origin does not match URL");
		const url = resolveSignetDaemonUrl({ env: {}, configUrl: target.url });
		this.target = { ...target, url, origin: new URL(url).origin };
		this.outbox = new DurableOutbox(this.target.origin, { env, harness: target.harness ?? "cli" });
		this.deliveryPaths = new Set(["/api/hooks/session-end", ...(options.deliveryPaths ?? [])]);
		for (const path of this.deliveryPaths) deliveryPath(path);
	}
	private async send<T>(
		method: string,
		path: string,
		opts: RequestOptions,
		capturedHeaders?: Readonly<Record<string, string>>,
		upload?: OutboxEntry["upload"],
		checkpoint?: UploadCheckpoint,
	): Promise<T> {
		let current = upload;
		const save = checkpoint
			? async (state: NonNullable<OutboxEntry["upload"]>) => {
					await checkpoint(state);
					current = state;
				}
			: undefined;
		for (const recovering of [false, true]) {
			try {
				return await this.sendAttempt<T>(method, path, opts, capturedHeaders, current, save, recovering);
			} catch (error) {
				if (
					!(error instanceof SignetApiError) ||
					error.status !== 422 ||
					!this.target.remote ||
					path !== "/api/hooks/session-end" ||
					!current ||
					!save
				)
					throw error;
				if (recovering)
					throw new SignetError(
						"Upload checksum failed after recovery; original transcript retained",
						"transcript_upload_checksum_failed",
					);
				await save({ ...current, uploadId: null, receivedBytes: 0 });
			}
		}
		throw new SignetError("Upload recovery exhausted", "transcript_upload_checksum_failed");
	}
	private async sendAttempt<T>(
		method: string,
		path: string,
		opts: RequestOptions,
		capturedHeaders?: Readonly<Record<string, string>>,
		upload?: OutboxEntry["upload"],
		checkpoint?: UploadCheckpoint,
		rehash = false,
	): Promise<T> {
		if (this.target.remote && path === "/api/hooks/session-end") {
			try {
				opts = {
					...opts,
					body: await captureRemoteSessionEnd(
						opts.body,
						opts.signal,
						checkpoint
							? {
									state: upload,
									rehash,
									checkpoint,
									request: (method, path, step) =>
										this.send(
											method,
											path,
											{
												...opts,
												...step,
												body: step.body,
												rawBody: step.rawBody,
												headers: { ...opts.headers, ...step.headers },
											},
											capturedHeaders,
										),
								}
							: undefined,
					),
				};
			} catch (error) {
				if (error instanceof SignetError || opts.signal?.aborted) throw error;
				throw new SignetError(
					error instanceof Error ? error.message : "Transcript capture failed",
					"transcript_capture_failed",
				);
			}
		}
		let used: string | null = null;
		let acquired = false;
		const callHeaders = new Headers(opts.headers);
		const fixed = new Headers(this.options.headers);
		if (capturedHeaders !== undefined) {
			for (const key of DELIVERY_SCOPE_HEADERS) {
				fixed.delete(key);
				callHeaders.delete(key);
			}
			for (const [key, value] of Object.entries(capturedHeaders)) fixed.set(key, value);
		}
		const transport = new SignetTransport({
			...this.options,
			headers: Object.fromEntries(fixed),
			baseUrl: this.target.url,
			credentialProvider: async () => {
				used = await this.target.credential.get(opts);
				acquired = true;
				return used;
			},
		});
		try {
			const value = await transport.request<T>(method, path, { ...opts, headers: Object.fromEntries(callHeaders) });
			return value;
		} catch (error) {
			if (
				!acquired ||
				used === null ||
				!(error instanceof SignetUnauthorizedError) ||
				error.reason !== "expired" ||
				!this.target.credential.refresh
			)
				throw error;
			try {
				const refresh = this.target.credential.refresh(used, opts);
				if (opts.signal) await abortable(refresh, opts.signal);
				else await refresh;
			} catch (failure) {
				if (opts.signal?.aborted) {
					if (opts.signal.reason instanceof Error && opts.signal.reason.name === "TimeoutError")
						throw new SignetTimeoutError(opts.timeoutMs ?? this.options.timeoutMs ?? 10_000);
					throw new SignetNetworkError("Request cancelled", new Error("cancelled"));
				}
				if (failure instanceof SignetError) throw failure;
				throw new SignetCredentialError(failure);
			}
			const value = await transport.request<T>(method, path, { ...opts, headers: Object.fromEntries(callHeaders) });
			return value;
		}
	}
	override async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
		const scope = requestSignal(opts, this.options.timeoutMs);
		const headers = new Headers(opts.headers);
		const delivery = method.toUpperCase() === "POST" && this.deliveryPaths.has(path);
		if (method.toUpperCase() === "POST" && this.deliveryPaths.has(path.split(/[?#]/, 1)[0] ?? "") && !delivery)
			throw new TypeError("Durable delivery scope must be in the JSON body");
		if (delivery && !headers.has("idempotency-key")) headers.set("idempotency-key", randomUUID());
		const request = {
			...opts,
			headers: Object.fromEntries(headers),
			signal: scope.signal,
			deadline: Date.now() + scope.timeoutMs,
		};
		try {
			let result: T;
			if (delivery) {
				if (
					Object.keys(opts.query ?? {}).length ||
					[...headers.keys()].some(
						(key) => key !== "idempotency-key" && !DELIVERY_SCOPE_HEADERS.some((name) => name === key),
					)
				)
					throw new TypeError(
						"Durable delivery scope and provenance must be in the JSON body or fixed transport headers",
					);
				const captured = new Headers(this.options.headers);
				for (const [key, value] of headers) captured.set(key, value);
				const delivered = await this.outbox.deliver(
					{
						method: "POST",
						path,
						body: opts.body ?? null,
						headers: captureDeliveryHeaders(Object.fromEntries(captured)),
						idempotencyKey: headers.get("idempotency-key") ?? undefined,
					},
					(entry, checkpoint) =>
						this.send<T>(method, path, { ...request, body: entry.body }, entry.headers, entry.upload, checkpoint),
					request,
				);
				result = delivered.value;
				if (delivered.cleanupError) {
					return result;
				}
			} else result = await this.send<T>(method, path, request);
			if (delivery) await this.flush({ signal: scope.signal, deadline: request.deadline });
			return result;
		} finally {
			scope.cleanup();
		}
	}
	async flush(options?: FlushOptions): Promise<OutboxFlushResult> {
		return this.outbox.flush(
			(entry, control, checkpoint) =>
				this.send(
					entry.method,
					entry.path,
					{ ...control, body: entry.body, headers: { "Idempotency-Key": entry.idempotencyKey } },
					entry.headers,
					entry.upload,
					checkpoint,
				),
			{ ...options, origin: this.target.origin, harness: this.target.harness ?? "cli" },
		);
	}
}
export function createNodeClient(target: ResolvedTarget, options?: NodeTransportOptions): SignetClient {
	return new SignetClient({ transport: new NodeTransport(target, options) });
}
