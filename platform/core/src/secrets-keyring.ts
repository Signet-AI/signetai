import { resolveRuntimeAsset } from "./runtime-assets";
import { createHash } from "node:crypto";
import { spawnHidden } from "./child-process";
import { decodeSecretMasterKey } from "./secrets-key.js";

export type SecretKeyringState =
	| "unchecked"
	| "found"
	| "missing"
	| "locked"
	| "unavailable"
	| "permission-denied"
	| "corrupt"
	| "unsupported";

export interface SecretKeyringResult {
	readonly state: SecretKeyringState;
	readonly value?: string;
	readonly message?: string;
	readonly backend?: "absent";
}

export interface SecretKeyringAccessOptions {
	readonly allowInteraction?: boolean;
	readonly signal?: AbortSignal;
}

export interface SecretKeyringAdapter {
	readonly platform: string;
	readonly service: string;
	readonly account: string;
	readonly get: (options?: SecretKeyringAccessOptions) => Promise<SecretKeyringResult>;
	readonly set: (value: string) => Promise<SecretKeyringResult>;
	readonly getStatus?: () => Promise<SecretKeyringResult>;
}

interface SecretKeyringHelperOverride {
	readonly entryPath: string;
	readonly deadlineMs: number | undefined;
}

interface SecretKeyringChildResponse {
	readonly ok: boolean;
	readonly result?: SecretKeyringResult;
	readonly state?: SecretKeyringState;
	readonly message?: string;
}

const SERVICE = "ai.signet.secrets";
const DEFAULT_DEADLINE_MS = 2_000;
const MACOS_DEADLINE_MS = 10_000;
const MAX_ACCOUNTS = 32;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const STATES = new Set<SecretKeyringState>([
	"unchecked",
	"found",
	"missing",
	"locked",
	"unavailable",
	"permission-denied",
	"corrupt",
	"unsupported",
]);
const reads = new Map<string, Promise<SecretKeyringResult>>();
const observations = new Map<string, SecretKeyringResult>();
let adapterForTests: SecretKeyringAdapter | null = null;
let helperForTests: SecretKeyringHelperOverride | null = null;
let interactiveRequest = false;
let mutation: Promise<void> = Promise.resolve();

function workspaceAccount(workspace: string): string {
	return createHash("sha256").update(workspace).digest("hex").slice(0, 32);
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]/g, " ").slice(0, 500);
}

function sourceHelperPath(): string {
	return resolveRuntimeAsset("secrets-keyring-child.js", import.meta.url);
}

function defaultDeadlineMs(): number {
	return process.platform === "darwin" ? MACOS_DEADLINE_MS : DEFAULT_DEADLINE_MS;
}

function observe(account: string, result: SecretKeyringResult): void {
	if (!observations.has(account) && observations.size >= MAX_ACCOUNTS) {
		const oldest = observations.keys().next().value;
		if (oldest !== undefined) observations.delete(oldest);
	}
	if (result.state === "found") {
		try {
			decodeSecretMasterKey(result.value).fill(0);
		} catch (error) {
			observations.set(account, { state: "corrupt", message: errorMessage(error) });
			return;
		}
	}
	observations.set(account, { state: result.state, message: result.message });
}

function helperCommand(): { readonly command: string; readonly args: readonly string[]; readonly deadlineMs: number } {
	if (helperForTests !== null)
		return {
			command: process.execPath,
			args: [helperForTests.entryPath],
			deadlineMs: helperForTests.deadlineMs ?? defaultDeadlineMs(),
		};
	if (process.env.SIGNET_COMPILED_NATIVE === "1")
		return { command: process.execPath, args: [], deadlineMs: defaultDeadlineMs() };
	return {
		command: process.platform === "darwin" && !process.versions.bun ? "bun" : process.execPath,
		args: [sourceHelperPath()],
		deadlineMs: defaultDeadlineMs(),
	};
}

function parseChildResponse(output: string, code: number | null): SecretKeyringResult {
	try {
		const parsed = JSON.parse(output) as SecretKeyringChildResponse;
		if (parsed.ok && parsed.result !== undefined && STATES.has(parsed.result.state)) {
			const { state, value, message, backend } = parsed.result;
			return {
				state,
				...(typeof value === "string" ? { value } : {}),
				...(typeof message === "string" ? { message: message.slice(0, 500) } : {}),
				...(backend === "absent" ? { backend } : {}),
			};
		}
		if (parsed.state !== undefined && STATES.has(parsed.state)) {
			return {
				state: parsed.state,
				...(parsed.message === undefined ? {} : { message: parsed.message.slice(0, 500) }),
			};
		}
	} catch {}
	return { state: "unavailable", message: `Native keyring helper exited with code ${code ?? "unknown"}` };
}

async function invoke(
	op: "get" | "set" | "status",
	service: string,
	account: string,
	value?: string,
	options: SecretKeyringAccessOptions = {},
): Promise<SecretKeyringResult> {
	if (options.signal?.aborted) return { state: "unavailable", message: "Keyring request cancelled" };
	const interactive = process.platform === "darwin" && options.allowInteraction === true;
	if (interactive && interactiveRequest)
		return { state: "unavailable", message: "A keychain authorization request is already in progress" };
	const helper = helperCommand();
	const child = spawnHidden(helper.command, helper.args, {
		stdio: ["pipe", "pipe", "ignore"],
		env: {
			...process.env,
			...(process.env.SIGNET_COMPILED_NATIVE === "1" ? { SIGNET_KEYRING_HELPER: "1" } : {}),
		},
	});
	if (interactive) interactiveRequest = true;
	const request = `${JSON.stringify({ op, service, account, ...(op === "set" ? { value } : {}), ...(interactive ? { allowInteraction: true } : {}) })}\n`;
	return await new Promise<SecretKeyringResult>((resolve) => {
		let output = "";
		let timedOut = false;
		let cancelled = false;
		let outputExceeded = false;
		let settled = false;
		const finish = (result: SecretKeyringResult): void => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", cancel);
			if (interactive) interactiveRequest = false;
			resolve(result);
		};
		const cancel = (): void => {
			cancelled = true;
			child.kill("SIGKILL");
		};
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) cancel();
		const timer = setTimeout(
			() => {
				timedOut = true;
				child.kill("SIGKILL");
			},
			interactive ? 120_000 : helper.deadlineMs,
		);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (outputExceeded) return;
			output += chunk;
			if (Buffer.byteLength(output, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
				outputExceeded = true;
				child.kill("SIGKILL");
			}
		});
		child.stdin?.on("error", () => {});
		child.once("error", (error) => {
			clearTimeout(timer);
			finish({
				state: "unavailable",
				message:
					helper.command === "bun" &&
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ENOENT"
						? "The noninteractive macOS keyring helper requires Bun on PATH"
						: `Native keyring helper could not start: ${errorMessage(error)}`,
			});
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (cancelled) {
				finish({ state: "unavailable", message: "Keyring request cancelled" });
				return;
			}
			if (timedOut) {
				finish({ state: "unavailable", message: "Native keyring helper deadline exceeded" });
				return;
			}
			if (outputExceeded) {
				finish({ state: "unavailable", message: "Native keyring helper output exceeded its limit" });
				return;
			}
			finish(parseChildResponse(output, code));
		});
		child.stdin?.end(request);
	});
}

class NativeSecretKeyringAdapter implements SecretKeyringAdapter {
	readonly platform = process.platform;
	readonly service = SERVICE;
	readonly account: string;

	constructor(workspace: string) {
		this.account = workspaceAccount(workspace);
	}

	get(options: SecretKeyringAccessOptions = {}): Promise<SecretKeyringResult> {
		if (options.allowInteraction === true)
			return invoke("get", this.service, this.account, undefined, options).then((result) => {
				observe(this.account, result);
				return result;
			});
		const pending = reads.get(this.account);
		if (pending) return pending;
		if (reads.size >= MAX_ACCOUNTS)
			return Promise.resolve({ state: "unavailable", message: "Keyring request limit reached" });
		const result = invoke("get", this.service, this.account)
			.then((result) => {
				observe(this.account, result);
				return result;
			})
			.finally(() => reads.delete(this.account));
		reads.set(this.account, result);
		return result;
	}

	getStatus(): Promise<SecretKeyringResult> {
		return Promise.resolve(
			observations.get(this.account) ?? {
				state: "unchecked",
				message: "Native keyring access has not been checked; health checks do not unlock secrets",
			},
		);
	}

	set(value: string): Promise<SecretKeyringResult> {
		const result = mutation
			.then(() => invoke("set", this.service, this.account, value))
			.then((result) => {
				observe(this.account, result);
				return result;
			});
		mutation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export function getSecretKeyring(workspace: string): SecretKeyringAdapter {
	return adapterForTests ?? new NativeSecretKeyringAdapter(workspace);
}

export function setSecretKeyringForTests(adapter: SecretKeyringAdapter | null): void {
	adapterForTests = adapter;
}

export function setSecretKeyringHelperForTests(override: SecretKeyringHelperOverride | null): void {
	helperForTests = override;
}

export function resetSecretKeyringModuleForTests(): void {
	mutation = Promise.resolve();
	reads.clear();
	observations.clear();
}
