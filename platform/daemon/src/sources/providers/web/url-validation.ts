export function isPrivateHostname(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h === "0.0.0.0") return true;
	if (h.startsWith("127.")) return true;
	if (h.startsWith("10.")) return true;
	if (h.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
	if (h.startsWith("169.254.")) return true;
	if (h.startsWith("100.")) {
		const second = Number.parseInt(h.split(".")[1], 10);
		if (second >= 64 && second <= 127) return true;
	}
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	if (h.startsWith("fe80:") || h.startsWith("fe80%")) return true;
	if ((h.startsWith("fc") || h.startsWith("fd")) && h.includes(":")) return true;
	if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;

	return false;
}
export function validatePublicHttpUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return "Only HTTP/HTTPS URLs are supported";
		}
		if (isPrivateHostname(parsed.hostname)) {
			return "Private/loopback addresses are not allowed";
		}
		return null;
	} catch {
		return "Invalid URL format";
	}
}
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
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
