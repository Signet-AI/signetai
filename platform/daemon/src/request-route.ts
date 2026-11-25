import type { Context } from "hono";
export function requestRoute(c: Context): string {
	if (
		/^\/api\/auth\/device\/[^/]+$/.test(c.req.path) &&
		!["start", "token", "approve"].includes(c.req.path.split("/").at(-1) ?? "")
	)
		return "/api/auth/device/:userCode";
	if (
		c.req.path.startsWith("/api/auth/invites/") &&
		!["/api/auth/invites/accept", "/api/auth/invites/lookup"].includes(c.req.path)
	)
		return "/api/auth/invites/:token";
	return c.req.routePath && c.req.routePath !== "*" ? c.req.routePath : "unmatched";
}
