import { DASHBOARD_HANDOFF_PARAM } from "../../../../libs/sdk/src/dashboard-handoff";
import { useSyncExternalStore } from "react";
export const TOKEN_KEY = "signet-token";

const MAX_TIMER_MS = 2 ** 31 - 1;
const MIN_RECHECK_MS = 5_000;
const MAX_RECHECK_MS = 300_000;
const EXPIRY_WARNING_MS = 300_000;

export interface SignInProvider {
	readonly id: string;
	readonly type: string;
	readonly enabled: boolean;
	readonly username?: string;
	readonly label?: string;
	readonly startPath?: string;
}

export interface Identity {
	readonly sub: string;
	readonly name: string | null;
	readonly role: string;
	readonly expiresAt: number;
}

export interface Whoami {
	readonly organization: { readonly name: string; readonly agentModel: string };
	readonly user: {
		readonly id: string;
		readonly username: string;
		readonly displayName: string;
		readonly email: string | null;
		readonly role: string;
		readonly compliance: boolean;
		readonly ssoManaged?: boolean;
		readonly groups: readonly {
			readonly id: string;
			readonly name: string;
			readonly role: string;
			readonly managedBy?: string;
		}[];
	};
	readonly agents: { readonly defaultRead: string; readonly defaultWrite: string | null };
	readonly credential: {
		readonly id: string;
		readonly kind: string;
		readonly expiresAt: string | null;
		readonly agentId?: string | null;
	};
}

export type Session =
	| { readonly kind: "checking" }
	| { readonly kind: "open"; readonly mode: string; readonly permissions: readonly string[] | null }
	| {
			readonly kind: "signed-in";
			readonly mode: string;
			readonly identity: Identity;
			readonly permissions: readonly string[] | null;
			readonly expiresSoon: boolean;
			readonly whoami?: Whoami;
	  }
	| {
			readonly kind: "signed-out";
			readonly mode: string;
			readonly providers: readonly SignInProvider[];
			readonly organizationName?: string;
			readonly whoami?: Whoami;
			readonly reason: string | null;
			readonly expired: boolean;
			readonly renewal: boolean;
			readonly permissions: readonly string[] | null;
	  }
	| { readonly kind: "unreachable"; readonly error: string };

export type SignInResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: string; readonly retryAfter?: number };

const demo =
	import.meta.env.VITE_DEMO === "1" || (import.meta.env.DEV && import.meta.env.VITE_ONBOARDING_PREVIEW === true);

let current: Session = demo ? { kind: "open", mode: "local", permissions: null } : { kind: "checking" };
let boot: Promise<void> | null = null;
let signedInOnce = false;
let lastWhoami: Whoami | null = null;
let pendingReason: string | null = null;
let refreshing: Promise<void> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let warningTimer: ReturnType<typeof setTimeout> | undefined;
let scheduledExpiry = 0;
let recheck = 0;
const listeners = new Set<() => void>();

export interface DashboardHandoffConfirmation {
	readonly userId: string;
	readonly userName: string;
	readonly organizationName: string;
	readonly instance: string;
	readonly busy: boolean;
	readonly error: string | null;
}
let pendingHandoffCode: string | null = null;
let handoffConfirmation: DashboardHandoffConfirmation | null = null;
function publishHandoff(value: DashboardHandoffConfirmation | null): void {
	handoffConfirmation = value;
	for (const listener of listeners) listener();
}
export function currentDashboardHandoff(): DashboardHandoffConfirmation | null {
	return handoffConfirmation;
}
export function useDashboardHandoff(): DashboardHandoffConfirmation | null {
	return useSyncExternalStore((listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, currentDashboardHandoff);
}
export function cancelDashboardHandoff(): void {
	pendingHandoffCode = null;
	publishHandoff(null);
}
export async function confirmDashboardHandoff(): Promise<void> {
	const code = pendingHandoffCode;
	const confirmation = handoffConfirmation;
	if (!code || !confirmation || confirmation.busy) return;
	publishHandoff({ ...confirmation, busy: true, error: null });
	const response = await request("/api/auth/handoff/redeem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code, confirm: true }),
	});
	if (pendingHandoffCode !== code) return;
	if (response?.status !== 200) {
		publishHandoff({
			...confirmation,
			busy: false,
			error: "The sign-in link expired or could not be confirmed. Cancel and sign in directly.",
		});
		return;
	}
	if (isRecord(response.body)) writeToken(text(response.body.token));
	cancelDashboardHandoff();
	await refreshSession();
}

let legacyToken: string | null = null;

export function readToken(): string | null {
	return legacyToken;
}

function writeToken(token: string | null): void {
	legacyToken = token;
}

export function authHeaders(): HeadersInit {
	const token = readToken();
	if (token) return { Authorization: `Bearer ${token}` };
	if (typeof document === "undefined") return {};
	const cookies = new Map(
		document.cookie.split("; ").map((entry) => {
			const index = entry.indexOf("=");
			return [entry.slice(0, index), entry.slice(index + 1)];
		}),
	);
	const csrf = cookies.get("__Host-signet_csrf") ?? cookies.get("signet_csrf");
	return csrf ? { "x-signet-csrf": csrf } : {};
}

function publish(next: Session): void {
	current = next;
	for (const listener of listeners) listener();
}

function set(next: Session): void {
	clearTimeout(expiryTimer);
	clearTimeout(warningTimer);
	if (next.kind !== "signed-in") {
		publish(next);
		return;
	}
	signedInOnce = true;
	const { expiresAt } = next.identity;
	recheck = expiresAt === scheduledExpiry ? Math.min(Math.max(recheck * 2, MIN_RECHECK_MS), MAX_RECHECK_MS) : 0;
	scheduledExpiry = expiresAt;
	const wait = Math.min(Math.max(expiresAt - Date.now() + 1_000, recheck), MAX_TIMER_MS);
	expiryTimer = setTimeout(() => void refreshSession(), wait);
	const warnIn = expiresAt - EXPIRY_WARNING_MS - Date.now();
	const expiresSoon =
		warnIn <= 0 || (current.kind === "signed-in" && current.identity.expiresAt === expiresAt && current.expiresSoon);
	if (warnIn > 0) {
		warningTimer = setTimeout(
			() => {
				if (current.kind === "signed-in") publish({ ...current, expiresSoon: true });
			},
			Math.min(warnIn, MAX_TIMER_MS),
		);
	}
	publish({ ...next, expiresSoon });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function sessionFetch(path: string, init: RequestInit = {}): Promise<Response> {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
		throw new Error("Dashboard requests must stay on this instance.");
	const headers = new Headers(authHeaders());
	new Headers(init.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	return fetch(path, { ...init, credentials: "same-origin", headers });
}

async function request(
	path: string,
	init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown; readonly retryAfter: string | null } | null> {
	try {
		const res = await sessionFetch(path, { ...init, signal: AbortSignal.timeout(15_000) });
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
		const type = text(entry.type) ?? id;
		if (!id || !type) return [];
		const username = text(entry.username);
		return [
			{
				id,
				type,
				enabled: entry.enabled !== false,
				...(username ? { username } : {}),
				...(text(entry.label) ? { label: String(entry.label) } : {}),
				...(text(entry.startPath) ? { startPath: String(entry.startPath) } : {}),
			},
		];
	});
}

function readWhoami(value: Record<string, unknown>): Whoami | undefined {
	const { organization, user, credential, agents } = value;
	if (!isRecord(organization) || !isRecord(user) || !isRecord(credential) || !isRecord(agents)) return;
	const name = text(organization.name);
	const agentModel = text(organization.agentModel);
	const id = text(user.id);
	const username = text(user.username);
	const displayName = text(user.displayName);
	const role = text(user.role);
	const credentialId = text(credential.id);
	const kind = text(credential.kind);
	const defaultRead = text(agents.defaultRead);
	if (!name || !agentModel || !id || !username || !displayName || !role || !credentialId || !kind || !defaultRead)
		return;
	const groups = Array.isArray(user.groups)
		? user.groups.flatMap((group: unknown) => {
				if (!isRecord(group)) return [];
				const id = text(group.id);
				const name = text(group.name);
				const role = text(group.role);
				return id && name && role
					? [{ id, name, role, ...(text(group.managedBy) ? { managedBy: String(group.managedBy) } : {}) }]
					: [];
			})
		: [];
	return {
		organization: { name, agentModel },
		user: {
			id,
			username,
			displayName,
			email: text(user.email),
			role,
			compliance: user.compliance === true,
			ssoManaged: user.ssoManaged === true,
			groups,
		},
		credential: { id: credentialId, kind, expiresAt: text(credential.expiresAt), agentId: text(credential.agentId) },
		agents: { defaultRead, defaultWrite: text(agents.defaultWrite) },
	};
}

export function useWhoami(): Whoami | null {
	const session = useSession();
	return session.kind === "unreachable"
		? lastWhoami
		: session.kind === "signed-in" || (session.kind === "signed-out" && session.expired)
			? (session.whoami ?? null)
			: null;
}

function readIdentity(value: unknown): Identity | null {
	if (!isRecord(value)) return null;
	const sub = text(value.sub);
	const role = text(value.role);
	if (!sub || !role || typeof value.exp !== "number") return null;
	return { sub, name: text(value.name), role, expiresAt: value.exp * 1000 };
}

function readPermissions(value: unknown): readonly string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((entry): entry is string => typeof entry === "string");
}

function describeRejection(error: string | null, fallback: string): string {
	if (error === "token expired") return "Your session expired. Sign in again.";
	if (error === "api key revoked") return "This API key was revoked.";
	if (error === "api key expired") return "This API key has expired.";
	return fallback;
}

async function check(retry = true): Promise<void> {
	const token = readToken();
	const res = await request("/api/auth/whoami", { headers: authHeaders() });
	if (retry && readToken() !== token) return check(false);
	if (res?.status !== 200 || !isRecord(res.body)) {
		set({ kind: "unreachable", error: res ? `Signet answered with HTTP ${res.status}.` : "Signet is not reachable." });
		return;
	}
	const body = res.body;
	const mode = text(body.mode) ?? "team";
	const whoami = readWhoami(body);
	if (isRecord(body.organization)) {
		writeToken(null);
		if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
	}
	const identity =
		body.authenticated === true && (!isRecord(body.organization) || body.accessMode === "authenticated")
			? whoami
				? {
						sub: whoami.user.id,
						name: whoami.user.displayName,
						role: whoami.user.role,
						expiresAt: whoami.credential.expiresAt
							? Date.parse(whoami.credential.expiresAt)
							: Date.now() + MAX_RECHECK_MS,
					}
				: readIdentity(body.claims)
			: null;
	const permissions = readPermissions(body.permissions);
	if (identity) {
		lastWhoami = whoami ?? null;
		pendingReason = null;
		set({ kind: "signed-in", mode, identity, permissions, expiresSoon: false, ...(whoami ? { whoami } : {}) });
		return;
	}
	if (isRecord(body.organization) ? body.accessMode === "open" : body.effectiveAccess === true) {
		lastWhoami = null;
		set({ kind: "open", mode, permissions });
		return;
	}
	if (token && readToken() === token) writeToken(null);
	const reason =
		pendingReason ??
		(token ? describeRejection(text(body.error), "The saved credential was rejected. Sign in again.") : null);
	pendingReason = null;
	set({
		kind: "signed-out",
		mode,
		providers: readProviders(body.providers),
		...(isRecord(body.organization) && text(body.organization.name)
			? { organizationName: String(body.organization.name) }
			: {}),
		reason,
		expired: signedInOnce,
		renewal: false,
		permissions: knownPermissions(),
		...(current.kind === "signed-in" && current.whoami ? { whoami: current.whoami } : {}),
	});
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
	const code = params.get(DASHBOARD_HANDOFF_PARAM);
	if (!code) return;
	params.delete(DASHBOARD_HANDOFF_PARAM);
	const hash = params.toString();
	history.replaceState(history.state, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
	pendingHandoffCode = code;
	publishHandoff(null);
	const res = await request("/api/auth/handoff/redeem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	if (pendingHandoffCode !== code) return;
	if (
		res?.status === 200 &&
		isRecord(res.body) &&
		res.body.confirmationRequired === true &&
		isRecord(res.body.user) &&
		isRecord(res.body.organization)
	) {
		const userName = text(res.body.user.displayName);
		const userId = text(res.body.user.id);
		const organizationName = text(res.body.organization.name);
		if (userName && userId && organizationName) {
			pendingHandoffCode = code;
			publishHandoff({ userId, userName, organizationName, instance: location.origin, busy: false, error: null });
			return;
		}
	}
	pendingHandoffCode = null;
	pendingReason = "The sign-in link from the CLI expired or was already used. Sign in here instead.";
}

export function startSession(): Promise<void> {
	if (boot) return boot;
	boot = demo ? Promise.resolve() : redeemHandoff().then(refreshSession);
	if (!demo && typeof window !== "undefined") {
		window.addEventListener("hashchange", () => {
			if (location.hash.includes(`${DASHBOARD_HANDOFF_PARAM}=`)) void redeemHandoff().then(refreshSession);
		});
		window.addEventListener("storage", (event) => {
			if (event.key === TOKEN_KEY || event.key === null) void refreshSession();
		});
	}
	return boot;
}
export function noteUnauthorized(): void {
	if (current.kind === "signed-in" || current.kind === "open" || current.kind === "unreachable") {
		void refreshSession();
	}
}

async function adopt(res: Awaited<ReturnType<typeof request>>): Promise<SignInResult> {
	const token = res?.status === 200 && isRecord(res.body) ? text(res.body.token) : null;
	if (res?.status !== 200) return { ok: false, error: "Signet did not return a session." };
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
		return Number.isFinite(seconds) && seconds > 0
			? { ok: false, error: `Too many attempts. Try again in ${seconds}s.`, retryAfter: seconds }
			: { ok: false, error: "Too many attempts. Try again shortly." };
	}
	const reason = isRecord(res.body) ? text(res.body.reason) : null;
	if (reason === "user_deactivated")
		return { ok: false, error: "Your account was deactivated. Contact an organization administrator." };
	if (reason === "org_policy")
		return { ok: false, error: "This sign-in method is not allowed by your organization. Use a configured provider." };
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
		headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	if (res?.status === 200) return adopt(res);
	const error = res && isRecord(res.body) ? text(res.body.error) : null;
	return failure(res, describeRejection(error, "That key was not accepted."));
}

export function requestRenewal(): void {
	if (current.kind !== "signed-in") return;
	void (async () => {
		const res = await request("/api/auth/methods", {});
		const providers = res?.status === 200 && isRecord(res.body) ? readProviders(res.body.providers) : [];
		if (current.kind !== "signed-in") return;
		publish({
			kind: "signed-out",
			mode: current.mode,
			providers,
			reason: "Sign in again to start a new session.",
			...(current.whoami ? { whoami: current.whoami, organizationName: current.whoami.organization.name } : {}),
			expired: true,
			renewal: true,
			permissions: current.permissions,
		});
	})();
}

export function cancelRenewal(): Promise<void> {
	return refreshSession();
}

function knownPermissions(): readonly string[] | null {
	return current.kind === "signed-in" || current.kind === "open" || current.kind === "signed-out"
		? current.permissions
		: null;
}

export function can(session: Session, permission: string): boolean {
	if (session.kind === "checking" || session.kind === "unreachable") return false;
	if ("whoami" in session && session.whoami && session.permissions === null) return false;
	return session.permissions === null || session.permissions.includes(permission);
}

export function useCan(permission: string): boolean {
	return can(useSession(), permission);
}

export async function signOut(all = false): Promise<void> {
	if (current.kind === "signed-in" && current.whoami) {
		const result = await request("/api/auth/logout", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ all }),
		});
		if (result?.status !== 200) throw new Error("Sign-out failed. Your session may still be active.");
	}
	writeToken(null);
	signedInOnce = false;
	lastWhoami = null;
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
