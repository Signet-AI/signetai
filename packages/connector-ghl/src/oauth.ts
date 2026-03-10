/**
 * GHL OAuth 2.0 Client
 *
 * Handles the authorization_code flow for GHL Marketplace Apps.
 *
 * Required setup:
 *   1. Register at https://marketplace.gohighlevel.com/
 *   2. Create an app, get client_id + client_secret
 *   3. Set redirect URI to http://localhost:{daemonPort}/api/ghl/callback
 *   4. Configure scopes (see REQUIRED_SCOPES below)
 *
 * Tokens are persisted via the storage abstraction so the daemon
 * can refresh them between sessions without re-authing the user.
 */

import type { GHLOAuthConfig, GHLOAuthTokens } from "./types.js";

const GHL_OAUTH_BASE = "https://marketplace.gohighlevel.com/oauth";
const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
const GHL_API_BASE = "https://services.leadconnectorhq.com";

export const REQUIRED_SCOPES = [
	"contacts.readonly",
	"contacts.write",
	"opportunities.readonly",
	"opportunities.write",
	"workflows.readonly",
	"locations/tags.readonly",
	"locations/tags.write",
	"calendars.readonly",
	"funnels.readonly",
	"users.readonly",
	"businesses.readonly",
	"locations.readonly",
	"conversations/message.readonly",
	"forms.readonly",
	"surveys.readonly",
	"medias.readonly",
] as const;

// ============================================================================
// Authorization URL
// ============================================================================

export interface AuthorizeParams {
	config: GHLOAuthConfig;
	state?: string;
}

/**
 * Build the GHL OAuth authorization URL.
 * Redirect the user/browser here to start the connect flow.
 */
export function buildAuthorizationUrl({ config, state }: AuthorizeParams): string {
	const params = new URLSearchParams({
		response_type: "code",
		redirect_uri: config.redirectUri,
		client_id: config.clientId,
		scope: config.scopes.join(" "),
	});
	if (state) params.set("state", state);
	return `${GHL_OAUTH_BASE}/chooselocation?${params.toString()}`;
}

// ============================================================================
// Token Exchange
// ============================================================================

/**
 * Exchange an authorization code for tokens.
 * Called from the /api/ghl/callback route after user approves.
 */
export async function exchangeCodeForTokens(
	code: string,
	config: GHLOAuthConfig
): Promise<GHLOAuthTokens> {
	const body = new URLSearchParams({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		grant_type: "authorization_code",
		code,
		redirect_uri: config.redirectUri,
	});

	const res = await fetch(GHL_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!res.ok) {
		const err = await res.text().catch(() => "unknown error");
		throw new Error(`GHL token exchange failed (${res.status}): ${err}`);
	}

	const data = (await res.json()) as Omit<GHLOAuthTokens, "expires_at">;
	return {
		...data,
		expires_at: Date.now() + data.expires_in * 1000,
	};
}

// ============================================================================
// Token Refresh
// ============================================================================

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshTokens(
	tokens: GHLOAuthTokens,
	config: GHLOAuthConfig
): Promise<GHLOAuthTokens> {
	const body = new URLSearchParams({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		grant_type: "refresh_token",
		refresh_token: tokens.refresh_token,
	});

	const res = await fetch(GHL_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!res.ok) {
		const err = await res.text().catch(() => "unknown error");
		throw new Error(`GHL token refresh failed (${res.status}): ${err}`);
	}

	const data = (await res.json()) as Omit<GHLOAuthTokens, "expires_at">;
	return {
		...data,
		// Preserve refresh_token if new one not returned
		refresh_token: data.refresh_token || tokens.refresh_token,
		expires_at: Date.now() + data.expires_in * 1000,
	};
}

// ============================================================================
// Token Guard
// ============================================================================

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Return valid tokens, refreshing if needed.
 * Pass a save callback to persist refreshed tokens.
 */
export async function ensureValidTokens(
	tokens: GHLOAuthTokens,
	config: GHLOAuthConfig,
	onRefreshed?: (newTokens: GHLOAuthTokens) => Promise<void>
): Promise<GHLOAuthTokens> {
	const needsRefresh = Date.now() >= tokens.expires_at - REFRESH_BUFFER_MS;
	if (!needsRefresh) return tokens;

	const refreshed = await refreshTokens(tokens, config);
	if (onRefreshed) await onRefreshed(refreshed);
	return refreshed;
}

// ============================================================================
// Authenticated API Fetch
// ============================================================================

export interface GHLApiOptions {
	tokens: GHLOAuthTokens;
	config: GHLOAuthConfig;
	onRefreshed?: (newTokens: GHLOAuthTokens) => Promise<void>;
}

/**
 * Make an authenticated request to the GHL API.
 * Auto-refreshes token if needed.
 */
export async function ghlApiFetch(
	path: string,
	options: GHLApiOptions & RequestInit = {} as GHLApiOptions & RequestInit
): Promise<Response> {
	const { tokens, config, onRefreshed, ...fetchOptions } = options;
	const validTokens = await ensureValidTokens(tokens, config, onRefreshed);

	const url = path.startsWith("http") ? path : `${GHL_API_BASE}${path}`;
	return fetch(url, {
		...fetchOptions,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${validTokens.access_token}`,
			Version: "2021-07-28",
			...(fetchOptions.headers as Record<string, string> || {}),
		},
	});
}

/**
 * Paginated GHL API fetch — yields all pages until exhausted.
 */
export async function* ghlApiPaginate<T>(
	path: string,
	options: GHLApiOptions,
	pageSize = 100
): AsyncGenerator<T[]> {
	let skip = 0;
	const separator = path.includes("?") ? "&" : "?";

	while (true) {
		const url = `${path}${separator}limit=${pageSize}&skip=${skip}`;
		const res = await ghlApiFetch(url, options);

		if (!res.ok) {
			const err = await res.text().catch(() => "error");
			throw new Error(`GHL API ${path} failed (${res.status}): ${err}`);
		}

		const body = (await res.json()) as { total?: number; data?: T[] } & Record<string, unknown>;

		// GHL uses different response shapes — handle common patterns
		const items = extractItems<T>(body);
		if (items.length === 0) break;
		yield items;

		if (!body.total || skip + items.length >= body.total) break;
		skip += items.length;
	}
}

/** Extract items array from varied GHL response shapes */
function extractItems<T>(body: Record<string, unknown>): T[] {
	// Common GHL response shapes
	for (const key of [
		"contacts",
		"opportunities",
		"workflows",
		"pipelines",
		"calendars",
		"tags",
		"funnels",
		"users",
		"customFields",
		"data",
	]) {
		if (Array.isArray(body[key])) return body[key] as T[];
	}
	if (Array.isArray(body)) return body as T[];
	return [];
}
