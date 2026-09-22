const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;
const THINK_RE = /<think>[\s\S]*?<\/think>\s*/g;
const TRAILING_COMMA_RE = /,\s*([}\]])/g;

export function stripFences(raw: string): string {
	const stripped = raw.replace(THINK_RE, "");
	const match = stripped.match(FENCE_RE);
	if (match) return match[1].trim();
	const arr = extractBalancedJsonArray(stripped);
	if (arr) return arr;
	const trimmed = stripped.trim();
	const brace = trimmed.indexOf("{");
	if (brace > 0) {
		return trimmed.slice(brace);
	}

	return trimmed;
}

export function tryParseJson(candidate: string): unknown | null {
	const trimmed = candidate.trim();
	if (!trimmed) return null;

	const attempts = [trimmed, trimmed.replace(TRAILING_COMMA_RE, "$1")];
	for (const attempt of attempts) {
		try {
			const parsed = JSON.parse(attempt);
			if (typeof parsed === "string") {
				try {
					return JSON.parse(parsed);
				} catch {
					return parsed;
				}
			}
			return parsed;
		} catch {}
	}

	return null;
}

export function extractBalancedJsonObjects(raw: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inString = false;
	let escaping = false;
	let start = -1;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		}
		if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				out.push(raw.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return out;
}

export function extractBalancedJsonObject(raw: string): string | null {
	const list = extractBalancedJsonObjects(raw);
	return list.length > 0 ? list[0] : null;
}
export function extractBalancedJsonArray(raw: string): string | null {
	let last = -1;
	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[") {
			if (depth === 0) last = i;
			depth++;
		}
		if (ch === "]") depth--;
	}

	if (last < 0) return null;
	depth = 0;
	inString = false;
	escaping = false;

	for (let i = last; i < raw.length; i++) {
		const ch = raw[i];

		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === "\\") {
				escaping = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[") depth++;
		if (ch === "]") {
			depth--;
			if (depth === 0) return raw.slice(last, i + 1);
		}
	}

	return null;
}
