export function extractAnchorTerms(text: string): string[] {
	const tokens = text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const token of tokens) {
		if (token.length < 6) continue;
		const hasDigit = /\d/.test(token);
		const hasHyphen = token.includes("-");
		const isLong = token.length >= 12;
		if (!hasDigit && !hasHyphen && !isLong) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
		if (terms.length >= 8) break;
	}
	return terms;
}
