/**
 * Secret-name normalization + validation, ported from the Svelte app's
 * issue-848-format.ts. Mirrors the daemon's SECRET_NAME_RE
 * (platform/daemon/src/bitwarden.ts, onepassword.ts): ^[A-Za-z_][A-Za-z0-9_]*$.
 */

export function normalizeSecretNameInput(value: string): string {
	return value
		.trim()
		.replace(/[\s.-]+/g, "_")
		.replace(/[^A-Za-z0-9_]/g, "")
		.replace(/_+/g, "_");
}

export function validateSecretName(name: string): string | null {
	if (!name) return "Secret name is required.";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		return "Use letters, numbers, and underscores; start with a letter or underscore.";
	}
	return null;
}
