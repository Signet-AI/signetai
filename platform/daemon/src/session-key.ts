export function normalizeSessionKey(sessionKey: string): string {
	const trimmed = sessionKey.trim();
	if (trimmed.startsWith("session:")) {
		return trimmed.slice("session:".length);
	}
	return trimmed;
}
