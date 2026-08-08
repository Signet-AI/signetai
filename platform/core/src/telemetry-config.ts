/**
 * Shared anonymous telemetry defaults.
 *
 * The PostHog project key is a public ingest key by design. Keeping the
 * defaults in core prevents the daemon and CLI from silently targeting
 * different projects.
 */

export const DEFAULT_TELEMETRY_POSTHOG_HOST = "https://us.i.posthog.com";
export const DEFAULT_TELEMETRY_POSTHOG_API_KEY = "phc_mLsvJmbmp6e9UarrX9Cq5QtTjVNiiphM9mvi5Xnddd8Q";
export const DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS = 60000;
export const DEFAULT_TELEMETRY_FLUSH_BATCH_SIZE = 50;
