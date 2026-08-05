import { randomUUID } from "node:crypto";
import type {
	AuthInteraction,
	OAuthAuth,
	OAuthCredentials,
	OAuthPrompt,
	OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { logger } from "./logger";
import { deleteSecretFromActiveProvider, getSecret, putSecret } from "./secrets";

// pi-ai 0.81+ loads its OAuth flows (anthropic, openai-codex, github-copilot,
// xai, radius) through a variable-specifier dynamic import so browser bundlers
// cannot follow it into Node-only flow code. In the compiled native binary
// that runtime import resolves against the bundle root and fails with
// "Cannot find module './anthropic.js'". Registering the statically bundled
// flows routes every lazy OAuth load through the embedded module instead;
// without it dashboard sign-in (and credential refresh) is broken on the
// shipped binary.
registerBunOAuthFlows();

const OAUTH_SECRET_PREFIX = "SIGNET_OAUTH_";
const OAUTH_SESSION_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_OAUTH_SESSIONS = 8;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export type OAuthLoginEvent =
	| { readonly type: "session"; readonly sessionId: string; readonly providerId: string }
	| { readonly type: "auth"; readonly url: string; readonly instructions?: string }
	| {
			readonly type: "device_code";
			readonly userCode: string;
			readonly verificationUri: string;
			readonly intervalSeconds?: number;
			readonly expiresInSeconds?: number;
	  }
	| ({ readonly type: "prompt"; readonly responseId: string } & OAuthPrompt)
	| ({ readonly type: "select"; readonly responseId: string } & OAuthSelectPrompt)
	| { readonly type: "manual_code"; readonly responseId: string; readonly message: string }
	| { readonly type: "progress"; readonly message: string }
	| { readonly type: "connected"; readonly providerId: string }
	| { readonly type: "error"; readonly error: string }
	| { readonly type: "done" };

export interface ResolvedOAuthCredential {
	readonly apiKey: string;
	readonly credentials: OAuthCredentials;
}

interface PendingInteraction {
	readonly responseId: string;
	readonly allowEmpty: boolean;
	readonly allowedValues?: ReadonlySet<string>;
	resolve(value: string | undefined): void;
	reject(error: Error): void;
}

type OAuthInteractionEvent =
	| { readonly type: "prompt"; readonly message: string; readonly placeholder?: string }
	| {
			readonly type: "select";
			readonly message: string;
			readonly options: readonly { readonly id: string; readonly label: string }[];
	  }
	| { readonly type: "manual_code"; readonly message: string };

interface OAuthLoginSession {
	readonly id: string;
	readonly providerId: string;
	readonly controller: AbortController;
	readonly pending: Map<string, PendingInteraction>;
	readonly expiresAt: number;
	emit(event: OAuthLoginEvent): void;
	close(): void;
}

const activeSessions = new Map<string, OAuthLoginSession>();
const refreshes = new Map<string, Promise<ResolvedOAuthCredential | null>>();

interface OAuthProvider {
	readonly id: string;
	readonly name: string;
	readonly oauth: OAuthAuth;
}

/** Pi's provider catalog is the production OAuth authority. Test registrations
 * exercise the same OAuthAuth contract without mutating process-global Pi state. */
const testProviders = new Map<string, OAuthProvider>();

function oauthProviders(): readonly OAuthProvider[] {
	const providers = new Map<string, OAuthProvider>();
	for (const provider of builtinProviders()) {
		if (provider.auth.oauth) {
			providers.set(provider.id, { id: provider.id, name: provider.name, oauth: provider.auth.oauth });
		}
	}
	for (const [id, provider] of testProviders) providers.set(id, provider);
	return [...providers.values()];
}

function oauthProvider(providerId: string): OAuthProvider | undefined {
	return oauthProviders().find((provider) => provider.id === providerId);
}

function validateProviderId(providerId: string): string {
	const normalized = providerId.trim();
	if (!PROVIDER_ID_PATTERN.test(normalized)) throw new Error("Invalid OAuth provider id");
	return normalized;
}

function secretName(providerId: string): string {
	const normalized = validateProviderId(providerId);
	return `${OAUTH_SECRET_PREFIX}${Buffer.from(normalized, "utf8").toString("hex").toUpperCase()}`;
}

function isOAuthCredentials(value: unknown): value is OAuthCredentials {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.refresh === "string" &&
		candidate.refresh.length > 0 &&
		typeof candidate.access === "string" &&
		candidate.access.length > 0 &&
		typeof candidate.expires === "number" &&
		Number.isFinite(candidate.expires) &&
		candidate.expires >= 0
	);
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\bBearer\s+[^\s,}]+/gi, "Bearer [redacted]")
		.replace(/([?&](?:code|token|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
		.slice(0, 500);
}

export function listOAuthProviderMetadata(): Array<{
	readonly id: string;
	readonly name: string;
	readonly usesCallbackServer: boolean;
}> {
	return oauthProviders().map((provider) => ({
		id: provider.id,
		name: provider.name,
		usesCallbackServer: false,
	}));
}

export function isOAuthProvider(providerId: string): boolean {
	return oauthProvider(providerId) !== undefined;
}

export async function loadOAuthCredentials(providerId: string): Promise<OAuthCredentials | null> {
	const name = secretName(providerId);
	let raw: string;
	try {
		raw = await getSecret(name);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not found|does not exist|no such/i.test(message)) return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Stored OAuth credentials for ${providerId} are invalid JSON`);
	}
	if (!isOAuthCredentials(parsed)) {
		throw new Error(`Stored OAuth credentials for ${providerId} have an invalid shape`);
	}
	return parsed;
}

export async function storeOAuthCredentials(providerId: string, credentials: OAuthCredentials): Promise<void> {
	if (!oauthProvider(validateProviderId(providerId))) throw new Error(`Unknown OAuth provider: ${providerId}`);
	if (!isOAuthCredentials(credentials)) throw new Error(`Invalid OAuth credentials for ${providerId}`);
	await putSecret(secretName(providerId), JSON.stringify(credentials));
}

export async function disconnectOAuthProvider(providerId: string): Promise<boolean> {
	if (!oauthProvider(validateProviderId(providerId))) throw new Error(`Unknown OAuth provider: ${providerId}`);
	return deleteSecretFromActiveProvider(secretName(providerId));
}

export async function isOAuthProviderConnected(providerId: string): Promise<boolean> {
	return (await loadOAuthCredentials(providerId)) !== null;
}

export async function resolveOAuthCredential(providerId: string): Promise<ResolvedOAuthCredential | null> {
	const normalized = validateProviderId(providerId);
	const existing = refreshes.get(normalized);
	if (existing) return existing;

	const pending = (async () => {
		const credentials = await loadOAuthCredentials(normalized);
		if (!credentials) return null;
		const provider = oauthProvider(normalized);
		if (!provider) return null;
		let resolved = credentials;
		try {
			if (resolved.expires <= Date.now()) {
				const refreshed = await provider.oauth.refresh({ ...resolved, type: "oauth" });
				resolved = { refresh: refreshed.refresh, access: refreshed.access, expires: refreshed.expires };
			}
		} catch (error) {
			logger.warn("inference", "OAuth credential refresh failed", {
				providerId: normalized,
				error: safeError(error),
			});
			return null;
		}
		const auth = await provider.oauth.toAuth({ ...resolved, type: "oauth" });
		if (!auth.apiKey) return null;
		if (JSON.stringify(resolved) !== JSON.stringify(credentials)) {
			await storeOAuthCredentials(normalized, resolved);
		}
		return { apiKey: auth.apiKey, credentials: resolved };
	})();
	refreshes.set(normalized, pending);
	try {
		return await pending;
	} finally {
		refreshes.delete(normalized);
	}
}

function createInteraction(
	session: OAuthLoginSession,
	event: OAuthInteractionEvent,
	allowEmpty: boolean,
	allowedValues?: ReadonlySet<string>,
): Promise<string | undefined> {
	if (session.controller.signal.aborted) return Promise.reject(new Error("Login cancelled"));
	const responseId = randomUUID();
	return new Promise<string | undefined>((resolve, reject) => {
		session.pending.set(responseId, { responseId, allowEmpty, allowedValues, resolve, reject });
		session.emit({ ...event, responseId } as OAuthLoginEvent);
	});
}

function cleanupSession(session: OAuthLoginSession, reason?: string): void {
	activeSessions.delete(session.id);
	for (const interaction of session.pending.values()) {
		interaction.reject(new Error(reason ?? "Login session closed"));
	}
	session.pending.clear();
}

export function startOAuthLogin(
	providerId: string,
	onCredentialsChanged?: () => void,
): {
	readonly sessionId: string;
	readonly stream: ReadableStream<Uint8Array>;
} {
	const normalized = validateProviderId(providerId);
	const provider = oauthProvider(normalized);
	if (!provider) throw new Error(`Unknown OAuth provider: ${normalized}`);
	if (activeSessions.size >= MAX_ACTIVE_OAUTH_SESSIONS) throw new Error("Too many active OAuth login sessions");

	const sessionId = randomUUID();
	const encoder = new TextEncoder();
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;
	const abortController = new AbortController();
	const session: OAuthLoginSession = {
		id: sessionId,
		providerId: normalized,
		controller: abortController,
		pending: new Map(),
		expiresAt: Date.now() + OAUTH_SESSION_TTL_MS,
		emit(event) {
			if (closed || !controllerRef) return;
			controllerRef.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				controllerRef?.close();
			} catch {
				// The consumer may already have cancelled the stream.
			}
		},
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controllerRef = controller;
			activeSessions.set(sessionId, session);
			session.emit({ type: "session", sessionId, providerId: normalized });
			const timeout = setTimeout(() => abortOAuthLogin(sessionId, "Login session expired"), OAUTH_SESSION_TTL_MS);
			timeout.unref?.();

			const callbacks: AuthInteraction = {
				signal: abortController.signal,
				notify: (event) => {
					if (event.type === "auth_url")
						session.emit({ type: "auth", url: event.url, instructions: event.instructions });
					else if (event.type === "device_code")
						session.emit({
							type: "device_code",
							userCode: event.userCode,
							verificationUri: event.verificationUri,
							intervalSeconds: event.intervalSeconds,
							expiresInSeconds: event.expiresInSeconds,
						});
					else session.emit({ type: "progress", message: event.message });
				},
				prompt: async (prompt) => {
					if (prompt.type === "select") {
						return (
							(await createInteraction(
								session,
								{ type: "select", message: prompt.message, options: prompt.options },
								false,
								new Set(prompt.options.map((option) => option.id)),
							)) ?? ""
						);
					}
					if (prompt.type === "manual_code") {
						return (await createInteraction(session, { type: "manual_code", message: prompt.message }, false)) ?? "";
					}
					return (
						(await createInteraction(
							session,
							{ type: "prompt", message: prompt.message, placeholder: prompt.placeholder },
							false,
						)) ?? ""
					);
				},
			};

			void provider.oauth
				.login(callbacks)
				.then(async (credentials) => {
					if (abortController.signal.aborted) throw new Error("Login cancelled");
					await storeOAuthCredentials(normalized, {
						refresh: credentials.refresh,
						access: credentials.access,
						expires: credentials.expires,
					});
					onCredentialsChanged?.();
					session.emit({ type: "connected", providerId: normalized });
					session.emit({ type: "done" });
				})
				.catch((error) => {
					session.emit({ type: "error", error: safeError(error) });
					session.emit({ type: "done" });
				})
				.finally(() => {
					clearTimeout(timeout);
					cleanupSession(session);
					session.close();
				});
		},
		cancel() {
			abortOAuthLogin(sessionId, "Client disconnected");
		},
	});

	return { sessionId, stream };
}

export function completeOAuthInteraction(sessionId: string, responseId: string, value: string): void {
	const session = activeSessions.get(sessionId);
	if (!session || session.expiresAt <= Date.now()) throw new Error("OAuth login session not found or expired");
	const interaction = session.pending.get(responseId);
	if (!interaction) throw new Error("OAuth login response not found or already completed");
	if (!interaction.allowEmpty && value.trim().length === 0) throw new Error("OAuth login response may not be empty");
	if (interaction.allowedValues && !interaction.allowedValues.has(value)) {
		throw new Error("OAuth login selection is not one of the offered options");
	}
	session.pending.delete(responseId);
	interaction.resolve(value);
}

export function abortOAuthLogin(sessionId: string, reason = "Login cancelled"): boolean {
	const session = activeSessions.get(sessionId);
	if (!session) return false;
	session.controller.abort(reason);
	cleanupSession(session, reason);
	session.close();
	return true;
}

export function resetOAuthStateForTests(): void {
	for (const sessionId of activeSessions.keys()) abortOAuthLogin(sessionId, "Test reset");
	refreshes.clear();
	testProviders.clear();
}

export function registerOAuthProviderForTests(provider: {
	readonly id: string;
	readonly name: string;
	readonly oauth: OAuthAuth;
}): void {
	testProviders.set(validateProviderId(provider.id), provider);
}
