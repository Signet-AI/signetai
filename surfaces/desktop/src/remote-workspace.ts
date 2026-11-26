import { attemptAsync } from "@signet/core/attempt";
import { LoginStore } from "@signet/sdk/node";
import { SignetTransport, SignetUnauthorizedError } from "@signet/sdk";
import { daemonRouteTarget } from "./protocol-routes.js";

export type WorkspaceSelection =
	| { readonly mode: "local" }
	| { readonly mode: "organization"; readonly origin: string };

export function parseWorkspaceSelection(value: unknown): WorkspaceSelection {
	if (typeof value !== "object" || value === null || !("mode" in value)) throw new Error("Invalid workspace selection");
	if (value.mode === "local") return { mode: "local" };
	if (value.mode !== "organization" || !("origin" in value) || typeof value.origin !== "string")
		throw new Error("An organization URL is required");
	const url = new URL(value.origin);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	)
		throw new Error(
			"Use an HTTPS instance origin without credentials, path, query, or fragment (HTTP is allowed only on loopback)",
		);
	return { mode: "organization", origin: url.origin };
}

export class DesktopWorkspace {
	constructor(
		readonly selection: WorkspaceSelection,
		private readonly local: { ensureStarted(): Promise<unknown> },
	) {}
	async prepare(): Promise<void> {
		if (this.selection.mode === "local") await this.local.ensureStarted();
	}
	assertLocal(): void {
		if (this.selection.mode !== "local") throw new Error("Local daemon controls are unavailable in organization mode");
	}
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid instance response");
	return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("Invalid instance response");
	return value;
}

export interface RemoteStatus {
	readonly state: "signed-out" | "signed-in" | "pending" | "expired" | "unreachable" | "forbidden" | "blocked";
	readonly origin: string;
	readonly message: string;
}

const PRIVATE_AUTH_PATHS = new Set([
	"/api/auth/login",
	"/api/auth/refresh",
	"/api/auth/device/start",
	"/api/auth/device/token",
	"/api/auth/logout",
	"/api/org/claim",
	"/api/auth/invites/accept",
	"/api/auth/sso/start",
	"/api/auth/sso/callback",
]);

export class RemoteWorkspace {
	readonly login: LoginStore;
	private readonly transport: SignetTransport;
	private flow: { deviceCode: string; userCode: string; expiresAt: number; nextPoll: number; interval: number } | null =
		null;
	private polling: Promise<RemoteStatus> | null = null;
	private statusValue: RemoteStatus;
	constructor(
		readonly origin: string,
		private readonly options: { login?: LoginStore; openExternal(url: string): Promise<void> },
	) {
		const selection = parseWorkspaceSelection({ mode: "organization", origin });
		if (selection.mode !== "organization") throw new Error("Organization required");
		this.origin = selection.origin;
		this.login = options.login ?? new LoginStore(this.origin);
		this.transport = new SignetTransport({ baseUrl: this.origin, retries: 0 });
		this.statusValue = { state: "signed-out", origin: this.origin, message: "Signed out" };
	}
	private status(state: RemoteStatus["state"], message: string): RemoteStatus {
		this.statusValue = { state, origin: this.origin, message };
		return this.statusValue;
	}
	private failure(error: unknown): RemoteStatus {
		if (error instanceof SignetUnauthorizedError)
			return this.status(
				error.reason === "missing_credential" ? "signed-out" : "expired",
				error.reason === "missing_credential" ? "Signed out" : "Session expired or revoked. Sign in again.",
			);
		return this.status("unreachable", "Unable to reach the instance or credential store. Try again.");
	}
	async signIn(): Promise<{ userCode: string; status: RemoteStatus }> {
		if (this.flow || this.polling) throw new Error("Sign-in is already pending");
		const flow = object(
			await this.transport.post("/api/auth/device/start", {
				client: "desktop",
				deviceName: "Signet Desktop",
				platform: process.platform,
			}),
		);
		const verification = new URL(text(flow.verificationUriComplete));
		if (
			verification.origin !== this.origin ||
			verification.username ||
			verification.password ||
			verification.hash ||
			[...verification.searchParams.keys()].some((key) => key !== "user_code")
		)
			throw new Error("Instance returned an unsafe verification URL");
		const userCode = text(flow.userCode);
		if (verification.searchParams.get("user_code") !== userCode)
			throw new Error("Instance returned an invalid verification code");
		this.flow = {
			deviceCode: text(flow.deviceCode),
			userCode,
			expiresAt: Date.now() + 600_000,
			nextPoll: Date.now() + 2000,
			interval: 2000,
		};
		try {
			await this.options.openExternal(verification.toString());
		} catch (error) {
			this.flow = null;
			throw error;
		}
		return { userCode, status: this.status("pending", "Approve the code in your browser, then return to Signet.") };
	}
	async pollSignIn(): Promise<RemoteStatus> {
		if (this.polling) return this.polling;
		this.polling = this.poll().finally(() => {
			this.polling = null;
		});
		return this.polling;
	}
	private async poll(): Promise<RemoteStatus> {
		const flow = this.flow;
		if (!flow) return this.sessionStatus();
		if (Date.now() >= flow.expiresAt) {
			this.flow = null;
			return this.status("expired", "Sign-in expired. Start again.");
		}
		if (Date.now() < flow.nextPoll) return this.statusValue;
		flow.nextPoll = Date.now() + flow.interval;
		try {
			const response = await fetch(`${this.origin}/api/auth/device/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceCode: flow.deviceCode }),
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			if (this.flow !== flow) return this.statusValue;
			if (response.status >= 500)
				return this.status("unreachable", `Instance returned HTTP ${response.status}. Waiting to retry sign-in.`);
			if (response.status === 428) return this.status("pending", "Waiting for approval in your browser.");
			if (response.status === 429) {
				flow.interval = Math.min(flow.interval + 5000, 30_000);
				return this.status("pending", "Waiting for approval in your browser.");
			}
			if (!response.ok) {
				this.flow = null;
				return this.status(
					response.status === 410 ? "expired" : "forbidden",
					response.status === 410 ? "Sign-in expired. Start again." : "Sign-in was denied. Start again.",
				);
			}
			const pair = object(await response.json());
			await this.login.save({
				accessToken: text(pair.accessToken),
				refreshToken: text(pair.refreshToken),
				accessExpiresAt: text(pair.accessExpiresAt),
				refreshExpiresAt: text(pair.refreshExpiresAt),
			});
			this.flow = null;
			return this.sessionStatus();
		} catch (error) {
			return this.failure(error);
		}
	}
	async sessionStatus(): Promise<RemoteStatus> {
		const response = await this.proxy(new Request("app://signet/api/auth/whoami"));
		if (!response.ok) return this.statusValue;
		const who = object(await response.json());
		if (who.authenticated !== true) return this.status("expired", "Session expired or revoked. Sign in again.");
		if (who.mode !== "team")
			return this.status("blocked", "This instance is not an authenticated organization workspace.");
		const user = object(who.user);
		return this.status("signed-in", `Signed in as ${text(user.displayName)} at ${this.origin}`);
	}
	async signOut(all = false): Promise<RemoteStatus> {
		if (this.polling) throw new Error("Wait for the pending sign-in request before signing out");
		this.flow = null;
		let token: string | null = null;
		try {
			token = await this.login.accessToken();
		} catch (error) {
			if (!(error instanceof SignetUnauthorizedError)) throw error;
		}
		if (token) {
			const response = await fetch(`${this.origin}/api/auth/logout`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ all }),
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok && response.status !== 401)
				throw new Error("Sign-out revocation was not confirmed; your shared login has not been removed");
		}
		await this.login.clear();
		return this.status("signed-out", "Signed out. The shared CLI and desktop login was removed.");
	}
	async proxy(request: Request): Promise<Response> {
		let path: string;
		try {
			path = decodeURIComponent(new URL(request.url).pathname).replace(/\/+$/, "");
		} catch {
			return Response.json({ error: "Invalid route" }, { status: 400 });
		}
		if (path === "/api/auth/logout") {
			if (request.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });
			let all = false;
			try {
				const encoded = await request.text();
				if (encoded.length > 1024) throw new Error("Logout body is too large");
				const payload = object(encoded ? JSON.parse(encoded) : {});
				if (payload.all !== undefined && typeof payload.all !== "boolean") throw new Error("Invalid logout scope");
				all = payload.all === true;
			} catch {
				return Response.json({ error: "Invalid logout request" }, { status: 400 });
			}
			try {
				await this.signOut(all);
				return Response.json({ ok: true });
			} catch (error) {
				const status = this.failure(error);
				return Response.json({ error: status.message }, { status: 502 });
			}
		}
		if (
			PRIVATE_AUTH_PATHS.has(path) ||
			(path.startsWith("/api/auth/") &&
				!/^\/api\/auth\/(?:whoami|methods|sessions(?:\/[^/]+)?|devices(?:\/[^/]+)?|connector-keys(?:\/[^/]+)?|api-keys(?:\/[^/]+)?|device\/approve|device\/[A-Z2-9-]+)$/.test(
					path,
				))
		)
			return Response.json({ error: "Use desktop sign-in controls", reason: "org_policy" }, { status: 403 });
		try {
			const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
			const token = await this.login.accessToken({ signal });
			if (!token) {
				this.status("signed-out", "Signed out");
				return Response.json({ error: "Sign in to your organization", reason: "missing_credential" }, { status: 401 });
			}
			const headers = new Headers(request.headers);
			for (const name of [
				"host",
				"origin",
				"cookie",
				"authorization",
				"x-signet-actor",
				"x-signet-actor-type",
				"x-signet-csrf",
				"forwarded",
				"x-forwarded-for",
				"x-forwarded-host",
				"x-forwarded-proto",
				"x-real-ip",
			])
				headers.delete(name);
			headers.set("authorization", `Bearer ${token}`);
			const response = await fetch(daemonRouteTarget(this.origin, request.url), {
				method: request.method,
				headers,
				body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
				redirect: "manual",
				signal,
			});
			if (response.status >= 300 && response.status < 400)
				return Response.json({ error: "Instance redirects are not allowed" }, { status: 502 });
			const responseHeaders = new Headers(response.headers);
			responseHeaders.delete("set-cookie");
			if (response.status === 401) this.status("expired", "Session expired or revoked. Sign in again.");
			if (response.status >= 500) this.status("unreachable", `Instance returned HTTP ${response.status}. Try again.`);
			if (response.status === 403) {
				const denied: unknown = await attemptAsync(() => response.clone().json());
				this.status(
					"forbidden",
					typeof denied === "object" && denied !== null && "required" in denied && typeof denied.required === "string"
						? denied.required
						: "Signed in, but not permitted (403).",
				);
			}
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		} catch (error) {
			const status = this.failure(error);
			return Response.json(
				{ error: status.message, reason: status.state },
				{ status: error instanceof SignetUnauthorizedError ? 401 : 502 },
			);
		}
	}
}
