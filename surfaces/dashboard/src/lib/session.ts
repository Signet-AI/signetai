import { useSyncExternalStore } from "react";

// The only reader and writer of the dashboard credential. The browser holds a session token here,
// never an API key: password sign-in, pasted keys, and CLI handoffs all exchange for a session first.
export const TOKEN_KEY = "signet-token";
const HANDOFF_PARAM = "signet-handoff";
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface SignInProvider {
	readonly id: string;
	readonly type: string;
	readonly enabled: boolean;
	readonly username?: string;
}

export interface Identity {
	readonly sub: string;
	readonly role: string;
	readonly expiresAt: number;
}

export type Session =
	| { readonly kind: "checking" }
	| { readonly kind: "open"; readonly mode: string }
	| { readonly kind: "signed-in"; readonly mode: string; readonly identity: Identity }
	| {
			readonly kind: "signed-out";
			readonly mode: string;
			readonly providers: readonly SignInProvider[];
			readonly reason: string | null;
			readonly expired: boolean;
	  }
	| { readonly kind: "unreachable"; readonly error: string };

export type SignInResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const demo =
	import.meta.env.VITE_DEMO === "1" || (import.meta.env.DEV && import.meta.env.VITE_ONBOARDING_PREVIEW === true);

let current: Session = demo ? { kind: "open", mode: "local" } : { kind: "checking" };
let boot: Promise<void> | null = null;
let signedInOnce = false;
let pendingReason: string | null = null;
let refreshing: Promise<void> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export function readToken(): string | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

function writeToken(token: string | null): void {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {}
}

export function authHeaders(): HeadersInit {
	const token = readToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

function set(next: Session): void {
	current = next;
	clearTimeout(expiryTimer);
	if (next.kind === "signed-in") {
		signedInOnce = true;
		const wait = Math.min(Math.max(next.identity.expiresAt - Date.now() + 1_000, 0), MAX_TIMER_MS);
		expiryTimer = setTimeout(() => void refreshSession(), wait);
	}
	for (const listener of listeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

async function request(
	path: string,
	init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown; readonly retryAfter: string | null } | null> {
	try {
		const res = await fetch(path, { ...init, signal: AbortSignal.timeout(15_000) });
		const body: unknown = await res.json().catch(() => null);
		return { status: res.status, body, retryAfter: res.headers.get("Retry-After") };
	} catch {
		return null;
	}
}

function readProviders(value: unknown): SignInProvider[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const id = text(entry.id);
		const type = text(entry.type);
		if (!id || !type) return [];
		const username = text(entry.username);
		return [{ id, type, enabled: entry.enabled === true, ...(username ? { username } : {}) }];
	});
}

function readIdentity(value: unknown): Identity | null {
	if (!isRecord(value)) return null;
	const sub = text(value.sub);
	const role = text(value.role);
	if (!sub || !role || typeof value.exp !== "number") return null;
	return { sub, role, expiresAt: value.exp * 1000 };
}

function describeRejection(error: string | null, fallback: string): string {
	if (error === "token expired") return "Your session expired. Sign in again.";
	if (error === "api key revoked") return "This API key was revoked.";
	if (error === "api key expired") return "This API key has expired.";
	return fallback;
}

async function check(): Promise<void> {
	const token = readToken();
	const res = await request("/api/auth/whoami", { headers: authHeaders() });
	if (res?.status !== 200 || !isRecord(res.body)) {
		set({ kind: "unreachable", error: res ? `Signet answered with HTTP ${res.status}.` : "Signet is not reachable." });
		return;
	}
	const body = res.body;
	const mode = text(body.mode) ?? "team";
	const identity = body.authenticated === true ? readIdentity(body.claims) : null;
	if (identity) {
		pendingReason = null;
		set({ kind: "signed-in", mode, identity });
		return;
	}
	if (body.effectiveAccess === true) {
		set({ kind: "open", mode });
		return;
	}
	if (token) writeToken(null);
	const reason =
		pendingReason ??
		(token ? describeRejection(text(body.error), "The saved credential was rejected. Sign in again.") : null);
	pendingReason = null;
	set({ kind: "signed-out", mode, providers: readProviders(body.providers), reason, expired: signedInOnce });
}

export function refreshSession(): Promise<void> {
	refreshing ??= check().finally(() => {
		refreshing = null;
	});
	return refreshing;
}

async function redeemHandoff(): Promise<void> {
	if (typeof location === "undefined" || typeof history === "undefined") return;
	const params = new URLSearchParams(location.hash.slice(1));
	const code = params.get(HANDOFF_PARAM);
	if (!code) return;
	params.delete(HANDOFF_PARAM);
	const hash = params.toString();
	history.replaceState(history.state, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
	const res = await request("/api/auth/handoff/redeem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	const token = res?.status === 200 && isRecord(res.body) ? text(res.body.token) : null;
	if (token) writeToken(token);
	else pendingReason = "The sign-in link from the CLI expired or was already used. Sign in here instead.";
}

export function startSession(): Promise<void> {
	if (boot) return boot;
	boot = demo ? Promise.resolve() : redeemHandoff().then(refreshSession);
	// A handoff link opened in a tab that already shows the dashboard only changes the hash.
	if (!demo && typeof window !== "undefined") {
		window.addEventListener("hashchange", () => {
			if (location.hash.includes(`${HANDOFF_PARAM}=`)) void redeemHandoff().then(refreshSession);
		});
	}
	return boot;
}

// Called by the API client when a request is rejected as unauthenticated.
export function noteUnauthorized(): void {
	if (current.kind === "signed-in" || current.kind === "open" || current.kind === "unreachable") {
		void refreshSession();
	}
}

async function adopt(res: Awaited<ReturnType<typeof request>>): Promise<SignInResult> {
	const token = res?.status === 200 && isRecord(res.body) ? text(res.body.token) : null;
	if (!token) return { ok: false, error: "Signet did not return a session." };
	writeToken(token);
	await refreshSession();
	return current.kind === "signed-in"
		? { ok: true }
		: { ok: false, error: "Signed in, but the session was not accepted." };
}

function failure(res: Awaited<ReturnType<typeof request>>, rejected: string): SignInResult {
	if (!res) return { ok: false, error: "Signet is not reachable." };
	if (res.status === 429) {
		const seconds = Number(res.retryAfter);
		return {
			ok: false,
			error:
				Number.isFinite(seconds) && seconds > 0
					? `Too many attempts. Try again in ${seconds}s.`
					: "Too many attempts. Try again shortly.",
		};
	}
	if (res.status === 401) return { ok: false, error: rejected };
	const error = isRecord(res.body) ? text(res.body.error) : null;
	return { ok: false, error: error ?? `Sign-in failed (HTTP ${res.status}).` };
}

export async function signInWithPassword(username: string, password: string): Promise<SignInResult> {
	const res = await request("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	if (res?.status === 200) return adopt(res);
	if (res?.status === 503) return { ok: false, error: "Password sign-in is not configured on this daemon." };
	return failure(res, "Wrong username or password.");
}

export async function signInWithKey(key: string): Promise<SignInResult> {
	const res = await request("/api/auth/session", {
		method: "POST",
		headers: { Authorization: `Bearer ${key.trim()}` },
	});
	if (res?.status === 200) return adopt(res);
	const error = res && isRecord(res.body) ? text(res.body.error) : null;
	return failure(res, describeRejection(error, "That key was not accepted."));
}

export function signOut(): Promise<void> {
	writeToken(null);
	signedInOnce = false;
	return refreshSession();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	void startSession();
	return () => listeners.delete(listener);
}

export function currentSession(): Session {
	return current;
}

export function useSession(): Session {
	return useSyncExternalStore(subscribe, currentSession, currentSession);
}
