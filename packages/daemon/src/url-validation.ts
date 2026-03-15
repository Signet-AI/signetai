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

	// IPv4 loopback + special
	if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") return true;

	// IPv4 RFC-1918 private ranges
	if (h.startsWith("10.")) return true;
	if (h.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;

	// IPv4 link-local (169.254.x.x — includes AWS/GCP/Azure metadata 169.254.169.254)
	if (h.startsWith("169.254.")) return true;

	// IPv6 loopback
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;

	// IPv6 link-local (fe80::/10)
	if (h.startsWith("fe80:") || h.startsWith("fe80%")) return true;

	// IPv6 unique local (fc00::/7 — equivalent of RFC-1918)
	if (h.startsWith("fc") || h.startsWith("fd")) return true;

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
