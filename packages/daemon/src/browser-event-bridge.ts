/**
 * Browser Event Bridge — Signet OS Phase 3/5
 *
 * Wires the CDP browser event transport (from packages/cli/src/browse.ts)
 * into the event bus. When the daemon starts, this module replaces the
 * default stdout transport with one that emits into the event bus.
 *
 * This means when `signet browse watch` runs inside the daemon context,
 * events flow to all event bus subscribers instead of just stdout.
 */

import type { SignetOSEvent } from "@signet/core";
import { eventBus } from "./event-bus.js";
import { logger } from "./logger.js";

let bridgeActive = false;

/**
 * Wire the browse.ts event transport into the event bus.
 * Call once at daemon startup.
 *
 * Uses dynamic import to avoid hard compile-time dependency on @signet/cli.
 * The CLI's browse module exports setEventTransport(fn) — we set it to
 * emit into the event bus.
 */
export async function initBrowserEventBridge(): Promise<void> {
	if (bridgeActive) {
		logger.warn("event-bridge", "Browser event bridge already initialized");
		return;
	}

	try {
		// Dynamic import — graceful degradation if CLI package not available.
		// @signet/cli/browse exports { setEventTransport }.
		// @ts-expect-error — @signet/cli subpath export has no .d.ts; types are cast inline
		const browseModule = (await import("@signet/cli/browse")) as {
			setEventTransport: (transport: (event: SignetOSEvent) => void) => void;
		};

		browseModule.setEventTransport((event: SignetOSEvent) => {
			// Forward browser events into the event bus
			eventBus.emit(event);
		});

		bridgeActive = true;
		logger.info("event-bridge", "Browser event bridge initialized — CDP events now flow to event bus");
	} catch (err) {
		// Non-fatal: the event bus still works, just without browser events
		logger.warn(
			"event-bridge",
			`Could not wire browser transport: ${err instanceof Error ? err.message : String(err)}. ` +
				"Browser events will not flow to the event bus.",
		);
	}
}

/**
 * Check if the bridge is active.
 */
export function isBrowserBridgeActive(): boolean {
	return bridgeActive;
}
