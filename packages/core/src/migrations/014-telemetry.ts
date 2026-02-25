/**
 * Migration 014: Telemetry Events
 *
 * Adds a table for anonymous, opt-in telemetry events that track token
 * usage, error rates, performance, and feature usage. Events persist
 * locally for the dashboard and predictor training data, and can
 * optionally be batched to a self-hosted PostHog instance.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS telemetry_events (
			id TEXT PRIMARY KEY,
			event TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			properties TEXT NOT NULL,
			sent_to_posthog INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_telemetry_events_event
			ON telemetry_events(event);
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_timestamp
			ON telemetry_events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_unsent
			ON telemetry_events(sent_to_posthog) WHERE sent_to_posthog = 0;
	`);
}
