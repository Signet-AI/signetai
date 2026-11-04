import { createHash } from "node:crypto";

export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function opaqueId(rng, prefix = "id", len = 10) {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	let out = "";
	for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
	return `${prefix}_${out}`;
}

export function shuffle(rng, items) {
	const a = [...items];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

export function sha256hex(input) {
	return createHash("sha256").update(input).digest("hex");
}
export function jobDigest(seed, rounds) {
	let h = createHash("sha256").update(seed).digest();
	for (let i = 1; i < rounds; i++) h = createHash("sha256").update(h).digest();
	return h.toString("hex");
}

export function readJsonl(text) {
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

const SECRET_PATTERNS = [
	/\b(sk|zai|glm)[-_][A-Za-z0-9._-]{16,}/g,
	/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
	/\b[A-Za-z0-9]{32}\.[A-Za-z0-9]{8,}\b/g,
	/(api[_-]?key|authorization|token|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
];
export function redact(value) {
	if (typeof value === "string") {
		let out = value;
		for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
		return out;
	}
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = /^(authorization|api[_-]?key|token|secret|password|guard.*)$/i.test(k) ? "[REDACTED]" : redact(v);
		}
		return out;
	}
	return value;
}

const MIN_KNOWN_SECRET = 6;

export function makeScrubber() {
	const known = new Set();
	let ordered = [];
	const register = (...values) => {
		for (const v of values.flat()) {
			if (typeof v === "string" && v.length >= MIN_KNOWN_SECRET && !known.has(v)) {
				known.add(v);
				ordered = [...known].sort((a, b) => b.length - a.length);
			}
		}
	};
	const text = (s) => {
		let out = s;
		for (const k of ordered) if (out.includes(k)) out = out.split(k).join("[SCRUBBED]");
		return out;
	};
	const walk = (v) => {
		if (typeof v === "string") return text(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const o = {};
			for (const [k, x] of Object.entries(v)) o[text(k)] = walk(x);
			return o;
		}
		return v;
	};
	return { register, scrub: (v) => redact(walk(v)), scrubText: (s) => redact(text(String(s))), size: () => known.size };
}
