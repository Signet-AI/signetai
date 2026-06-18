export function formatDaemonUptime(seconds: number | null | undefined): string {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--";
	const totalSeconds = Math.floor(seconds);
	if (totalSeconds < 60) return `${totalSeconds}S`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}M`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}H`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "1 DAY" : `${days} DAYS`;
}

const ACRONYMS = new Set(["id", "api", "llm", "url", "uri", "http", "https", "ms"]);

export function humanizeConfigKey(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return words
		.map((word) => {
			const lower = word.toLowerCase();
			if (ACRONYMS.has(lower)) return lower.toUpperCase();
			return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
		})
		.join(" ");
}

export function normalizeSecretNameInput(value: string): string {
	return value.trim().replace(/[\s.-]+/g, "_").replace(/[^A-Za-z0-9_]/g, "").replace(/_+/g, "_");
}

export function validateSecretName(name: string): string | null {
	if (!name) return "Secret name is required.";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		return "Use letters, numbers, and underscores; start with a letter or underscore.";
	}
	return null;
}

export function summarizeOntologyText(value: string, maxChars = 220): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (!collapsed) return "";
	const withoutAgentXml = collapsed
		.replace(/<\/?(?:agent|assistant|user|system|tool|message|transcript|conversation|turn|content|text)[^>]*>/gi, " ")
		.replace(/<[^>]{1,80}>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const text = withoutAgentXml || collapsed;
	return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : text;
}

export function sourceHasChunkCoverageWarning(
	stats?: { artifacts: number; chunks: number; indexed: number } | null,
): boolean {
	return Boolean(stats && stats.indexed > 0 && stats.chunks === 0);
}
