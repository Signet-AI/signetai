import type { Context } from "hono";
import type { AuthConfig } from "./config";
import { resolveRequestNetwork } from "./request-network";
export const DEVELOPMENT_ORIGINS = new Set([
	"http://localhost:3850",
	"http://127.0.0.1:3850",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"app://signet",
]);
export function acceptRequestOrigin(c: Context, config: AuthConfig, publicUrl: string | null): boolean {
	const origin = c.req.header("origin");
	if (!origin) return true;
	const network = resolveRequestNetwork(c, config);
	let reason: "request" | "proxy" | "public" | "development" | null = null;
	if (origin === network.origin) reason = network.trustedProxy ? "proxy" : "request";
	else if (publicUrl && origin === new URL(publicUrl).origin) reason = "public";
	else if (config.mode !== "team" && DEVELOPMENT_ORIGINS.has(origin)) reason = "development";
	c.set("acceptedOrigin", reason);
	if (reason) {
		c.header("Access-Control-Allow-Origin", origin);
		c.header("Access-Control-Allow-Credentials", "true");
	}
	return reason !== null;
}
