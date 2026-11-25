import type { Context } from "hono";
export function authCookies(c: Context, org: { readonly public_url: string | null } | null = c.get("organization")) {
	const secure = new URL(c.req.url).protocol === "https:" || org?.public_url?.startsWith("https:") === true;
	const prefix = secure ? "__Host-" : "";
	return {
		secure,
		session: `${prefix}signet_session`,
		csrf: `${prefix}signet_csrf`,
		state: `${prefix}signet_oidc_state`,
	};
}
