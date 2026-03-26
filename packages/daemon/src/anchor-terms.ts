export function extractAnchorTerms(text: string): string[] {
	const tokens = text.toLowerCase().match(/[a-z0-9_:/.-]+/g) ?? [];
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const token of tokens) {
		if (token.length < 6) continue;
		const hasDigit = /\d/.test(token);
		const hasMarker = /[_:/.-]/.test(token);
		const isVeryLong = token.length >= 18;
		if (!hasDigit && !hasMarker && !isVeryLong) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
		if (terms.length >= 8) break;
	}
	return terms;
}
