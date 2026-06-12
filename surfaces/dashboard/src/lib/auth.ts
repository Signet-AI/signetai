import { browser } from "$app/environment";

const TOKEN_KEY = "signet:dashboard:auth-token";
const EXPIRY_KEY = "signet:dashboard:auth-expires-at";

let fetchInstalled = false;
let originalFetch: typeof window.fetch | null = null;
let configuredApiBase = "";

export function getDashboardAuthToken(): string | null {
	if (!browser) return null;
	const expiresAt = localStorage.getItem(EXPIRY_KEY);
	if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
		clearDashboardAuthToken();
		return null;
	}
	return localStorage.getItem(TOKEN_KEY);
}

export function setDashboardAuthToken(token: string, expiresAt: string): void {
	if (!browser) return;
	localStorage.setItem(TOKEN_KEY, token);
	localStorage.setItem(EXPIRY_KEY, expiresAt);
}

export function clearDashboardAuthToken(): void {
	if (!browser) return;
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(EXPIRY_KEY);
}

function mergeAuthHeader(init: RequestInit | undefined): RequestInit | undefined {
	const token = getDashboardAuthToken();
	if (!token) return init;
	const headers = new Headers(init?.headers);
	if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
	return { ...init, headers };
}

function isProtectedDaemonPath(pathname: string): boolean {
	return pathname.startsWith("/api/") || pathname.startsWith("/memory/") || pathname === "/mcp" || pathname.startsWith("/v1/");
}

export function setDashboardAuthApiBase(apiBase: string): void {
	configuredApiBase = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
}

function shouldAttachAuth(input: RequestInfo | URL, apiBase: string): boolean {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	if (raw.startsWith("/") && isProtectedDaemonPath(raw)) return true;
	if (apiBase && (raw.startsWith(`${apiBase}/api/`) || raw.startsWith(`${apiBase}/memory/`) || raw === `${apiBase}/mcp` || raw.startsWith(`${apiBase}/v1/`))) {
		return true;
	}
	try {
		const parsed = new URL(raw, browser ? window.location.href : "http://localhost");
		if (!isProtectedDaemonPath(parsed.pathname)) return false;
		return browser && parsed.origin === window.location.origin;
	} catch {
		return false;
	}
}

export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetch(input, shouldAttachAuth(input, configuredApiBase) ? mergeAuthHeader(init) : init);
}

export function installDashboardAuthFetch(apiBase: string): void {
	setDashboardAuthApiBase(apiBase);
	if (!browser || fetchInstalled) return;
	fetchInstalled = true;
	originalFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const nextInit = shouldAttachAuth(input, apiBase) ? mergeAuthHeader(init) : init;
		return (originalFetch ?? fetch)(input, nextInit);
	};
}

export interface AuthEventStream {
	close(): void;
}

export function openAuthEventStream(
	url: string,
	handlers: {
		onopen?: () => void;
		onmessage: (event: { data: string }) => void;
		onerror?: () => void;
	},
): AuthEventStream {
	const controller = new AbortController();
	let closed = false;

	async function pump(): Promise<void> {
		try {
			const response = await authFetch(url, {
				headers: { Accept: "text/event-stream" },
				signal: controller.signal,
			});
			if (!response.ok || !response.body) throw new Error(`SSE request failed with HTTP ${response.status}`);
			handlers.onopen?.();

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (!closed) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				buffer = buffer.replace(/\r\n/g, "\n");
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const rawEvent = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = rawEvent
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (data) handlers.onmessage({ data });
					boundary = buffer.indexOf("\n\n");
				}
			}
			if (!closed) handlers.onerror?.();
		} catch {
			if (!closed) handlers.onerror?.();
		}
	}

	void pump();
	return {
		close() {
			closed = true;
			controller.abort();
		},
	};
}
