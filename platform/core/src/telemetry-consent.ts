export const TELEMETRY_CONSENT_TITLE = "Share anonymous usage data?";

export const TELEMETRY_CONSENT_BODY = [
	"Signet can send anonymous usage data to help us fix crashes and see which features get used. It stays off unless you turn it on.",
	"Sent: install and version counts, platform, which features and harnesses get used, token and cost totals per provider, and crash reports with home paths removed. Events carry a random install ID.",
	"Never sent: memory content, prompts, responses, search queries, file paths, or your name or accounts.",
	"Events go to PostHog in the US, which sees the IP address they come from. Every event is also written to `runtime/telemetry/events.jsonl` in your workspace, so you can read exactly what was recorded. The npm package also sends one anonymous install count, version and platform only, when it installs; set `SIGNET_TELEMETRY_OPTOUT=1` before installing to skip it. Apart from that, nothing is recorded until you say yes.",
	"Change this any time with `signet telemetry on` or `signet telemetry off`, or in Settings → Advanced.",
] as const;

export const TELEMETRY_CONSENT_PATH = ["memory", "pipelineV2", "telemetryEnabled"] as const;

export function readTelemetryConsent(config: unknown): boolean | undefined {
	if (!config || typeof config !== "object" || !("memory" in config)) return undefined;
	const memory = config.memory;
	if (!memory || typeof memory !== "object" || !("pipelineV2" in memory)) return undefined;
	const pipeline = memory.pipelineV2;
	if (!pipeline || typeof pipeline !== "object" || !("telemetryEnabled" in pipeline)) return undefined;
	return typeof pipeline.telemetryEnabled === "boolean" ? pipeline.telemetryEnabled : undefined;
}
