import { BlockList, isIP } from "node:net";
import type { Context } from "hono";
import type { AuthConfig } from "./config";

const policies = new WeakMap<readonly string[], BlockList>();
export function normalizeTrustedProxies(values: readonly string[]): readonly string[] {
	const entries: string[] = [],
		policy = new BlockList();
	for (const value of values) {
		const parts = value.trim().split("/");
		const address = parts[0] ?? "",
			family = isIP(address);
		const prefix = parts[1];
		if (
			!family ||
			parts.length > 2 ||
			(prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
		)
			throw new Error("auth.trustedProxies must contain valid IP addresses or CIDRs");
		const normalized = family === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
		const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
		policy.addSubnet(normalized, bits, family === 4 ? "ipv4" : "ipv6");
		entries.push(`${normalized}/${bits}`);
	}
	const result = Object.freeze([...new Set(entries)]);
	policies.set(result, policy);
	return result;
}
function trusted(entries: readonly string[], address: string): boolean {
	const policy = policies.get(entries);
	if (!policy) throw new Error("Trusted proxies were not normalized");
	const family = isIP(address);
	return family !== 0 && policy.check(address, family === 4 ? "ipv4" : "ipv6");
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
export function getPeerAddress(c: Context): string | null {
	const env: unknown = c.env;
	if (!record(env) || !record(env.incoming) || !record(env.incoming.socket)) return null;
	const address = env.incoming.socket.remoteAddress;
	return typeof address === "string" && isIP(address) !== 0 ? address : null;
}
export interface RequestNetwork {
	readonly peer: string | null;
	readonly client: string | null;
	readonly origin: string;
	readonly trustedProxy: boolean;
	readonly secure: boolean;
}
declare module "hono" {
	interface ContextVariableMap {
		requestNetwork: RequestNetwork;
		acceptedOrigin: "request" | "proxy" | "public" | "development" | null;
	}
}
export function resolveRequestNetwork(c: Context, config: AuthConfig): RequestNetwork {
	const existing = c.get("requestNetwork");
	if (existing) return existing;
	const peer = getPeerAddress(c),
		trustedProxy = peer !== null && trusted(config.trustedProxies, peer);
	let client = peer;
	let url = new URL(c.req.url);
	if (trustedProxy) {
		const value = c.req.header("x-forwarded-for");
		if (value && value.length <= 8192) {
			const hops = value.split(",").map((part) => part.trim());
			if (hops.length <= 128 && hops.every((hop) => isIP(hop) !== 0)) {
				for (let i = hops.length - 1; i >= 0; i--) {
					const hop = hops[i];
					if (hop && !trusted(config.trustedProxies, hop)) {
						client = hop;
						break;
					}
				}
			}
		}
		const proto = c.req.header("x-forwarded-proto")?.trim().toLowerCase(),
			host = c.req.header("x-forwarded-host")?.trim();
		if ((proto === "http" || proto === "https" || host) && (host === undefined || !/[\s,/\\?#@]/.test(host))) {
			try {
				const forwarded = new URL(
					`${proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1)}://${host ?? url.host}`,
				);
				if (forwarded.host && forwarded.pathname === "/") url = forwarded;
			} catch {
				throw new Error("Trusted proxy supplied an invalid forwarded host");
			}
		}
	}
	const result = { peer, client, origin: url.origin, trustedProxy, secure: url.protocol === "https:" };
	c.set("requestNetwork", result);
	return result;
}
export function getRequestOrigin(c: Context): string {
	return c.get("requestNetwork")?.origin ?? new URL(c.req.url).origin;
}
export function getClientAddress(c: Context): string | null {
	return c.get("requestNetwork")?.client ?? getPeerAddress(c);
}

export function rateLimitClientAddress(c: Context): string | null {
	const address = getClientAddress(c);
	if (!address || isIP(address) !== 6) return address;
	const canonical = new URL(`http://[${address.split("%")[0]}]`).hostname.slice(1, -1);
	const halves = canonical.split("::");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
	const words = groups.map((group) => Number.parseInt(group, 16));
	if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
		const high = words[6] ?? 0,
			low = words[7] ?? 0;
		return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
	}
	return `${words
		.slice(0, 4)
		.map((word) => word.toString(16))
		.join(":")}::/64`;
}
