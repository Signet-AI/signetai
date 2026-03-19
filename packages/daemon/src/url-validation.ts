/**
 * URL validation utilities — shared across install endpoint and MCP probe.
 *
 * Blocks SSRF to internal services, cloud metadata endpoints (169.254.169.254),
 * and private network addresses.
 */

/**
 * Check if a hostname resolves to a private, loopback, or link-local address.
 * Covers:
 * - IPv4 loopback (127.x, 0.0.0.0)
 * - IPv4 RFC-1918 (10.x, 172.16-31.x, 192.168.x)
 * - IPv4 link-local (169.254.x — AWS/GCP/Azure metadata endpoint)
 * - IPv6 loopback (::1)
 * - IPv6 link-local (fe80::/10)
 * - IPv6 unique local (fc00::/7)
 * - mDNS/internal suffixes (.local, .internal, .localhost)
 */
export function isPrivateHostname(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

	// IPv4 loopback (full 127.0.0.0/8 range) + special
	if (h === "localhost" || h === "0.0.0.0") return true;
	if (h.startsWith("127.")) return true;

	// IPv4 RFC-1918 private ranges
	if (h.startsWith("10.")) return true;
	if (h.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;

	// IPv4 link-local (169.254.x.x — includes AWS/GCP/Azure metadata 169.254.169.254)
	if (h.startsWith("169.254.")) return true;

	// IPv4 shared address space (RFC 6598 — 100.64.0.0/10: 100.64–127.x)
	if (h.startsWith("100.")) {
		const second = Number.parseInt(h.split(".")[1], 10);
		if (second >= 64 && second <= 127) return true;
	}

	// IPv6 loopback
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;

	// IPv6 link-local (fe80::/10)
	if (h.startsWith("fe80:") || h.startsWith("fe80%")) return true;

	// IPv6 unique local (fc00::/7 — equivalent of RFC-1918)
	// Only match actual IPv6 addresses (contain colons), not hostnames like fcc.gov
	if ((h.startsWith("fc") || h.startsWith("fd")) && h.includes(":")) return true;

	// mDNS / internal suffixes
	if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;

	return false;
}

/**
 * Validate a URL: must be http/https and not point to a private address.
 * Returns null if valid, or an error string if invalid.
 */
export function validatePublicHttpUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return "Only HTTP/HTTPS URLs are supported";
		}
		if (isPrivateHostname(parsed.hostname)) {
			return "Private/loopback addresses are not allowed";
		}
		return null; // valid
	} catch {
		return "Invalid URL format";
	}
}

/**
 * Fetch a public URL with SSRF protection. Validates the initial URL and
 * follows redirects manually so each hop is checked against the blocklist.
 * Returns the final Response (max 5 redirects).
 */
export async function safeFetch(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const MAX_REDIRECTS = 5;
	let current = url;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const err = validatePublicHttpUrl(current);
		if (err) throw new Error(`${err}: ${current}`);

		const res = await fetch(current, { ...init, redirect: "manual" });

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) throw new Error("Redirect with no Location header");
			current = new URL(location, current).href;
			continue;
		}

		return res;
	}

	throw new Error("Too many redirects");
}
