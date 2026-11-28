import type { Context, MiddlewareHandler } from "hono";
import type {} from "./auth/identity-middleware";
import routeEffects from "./route-effects.json";

const hostRoutes = Object.values(routeEffects).flatMap((routes) =>
	Object.entries(routes).flatMap(([route, effect]) => {
		if (effect !== "host" && effect !== "host-input") return [];
		const separator = route.indexOf(" ");
		const method = route.slice(0, separator);
		const path = route.slice(separator + 1).replace(/\$\{[^}]+\}/g, ":effect");
		const pattern = path
			.split("/")
			.map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
			.join("/");
		return [{ method, pattern: new RegExp(`^${pattern}/?$`), effect }];
	}),
);

const declarations = Object.values(routeEffects).flatMap((routes) =>
	Object.keys(routes).map((route) => {
		const separator = route.indexOf(" ");
		const method = route.slice(0, separator);
		const parts = route.slice(separator + 1).split(/\$\{[^}]+\}/g);
		const pattern = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
		return { method, pattern: new RegExp(`^${pattern}$`) };
	}),
);

export function requireLocalHost(c: Context): Response | undefined {
	if (c.get("organization") && c.get("principal")?.kind !== "local")
		return c.json(
			{ error: "Run this operation on the instance host with the local credential", reason: "local_required" },
			403,
		);
	return undefined;
}

export const hostRouteGuard: MiddlewareHandler = async (c, next) => {
	const matched = [...c.req.matchedRoutes].reverse();
	const registered =
		matched.find((route) => route.method !== "ALL") ?? matched.find((route) => !route.path.includes("*"));
	if (
		registered &&
		registered.path !== "*" &&
		!declarations.some((entry) => entry.method === registered.method && entry.pattern.test(registered.path))
	) {
		const denied = requireLocalHost(c);
		if (denied) return denied;
	}
	const route = hostRoutes.find(
		(entry) =>
			(entry.method === c.req.method || (c.req.method === "HEAD" && entry.method === "GET")) &&
			entry.pattern.test(c.req.path),
	);
	if (route) {
		const body: unknown = c.get("parsedJsonBody");
		const hostInput =
			typeof body === "object" &&
			body !== null &&
			["transcriptPath", "transcript_path"].some(
				(key) => typeof Reflect.get(body, key) === "string" && Reflect.get(body, key).length > 0,
			);
		if (route.effect === "host" || hostInput) {
			const denied = requireLocalHost(c);
			if (denied) return denied;
		}
	}
	return next();
};
