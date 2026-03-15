/**
 * Event Bus API routes — Signet OS Phase 3/5
 *
 * Exposes the event bus via HTTP for the dashboard and external consumers:
 *   GET  /api/os/events        — query recent events
 *   GET  /api/os/events/stream — SSE real-time event stream
 *   GET  /api/os/context       — ambient context snapshot
 *   GET  /api/os/events/stats  — bus diagnostics
 */

import type { Hono } from "hono";
import type { SignetOSEvent } from "@signet/core";
import { eventBus } from "../event-bus.js";

/**
 * Mount event bus routes on the Hono app.
 */
export function mountEventBusRoutes(app: Hono): void {
	/**
	 * GET /api/os/events — query recent events from the rolling window.
	 *
	 * Query params:
	 *   ?type=browser.navigate  — filter by event type
	 *   ?limit=50               — max events to return (default 50, max 500)
	 *   ?windowMs=300000        — rolling window in ms (default 5 min)
	 */
	app.get("/api/os/events", (c) => {
		const type = c.req.query("type") || undefined;
		const limit = Math.min(
			Math.max(1, Number.parseInt(c.req.query("limit") || "50", 10) || 50),
			500,
		);
		const windowMs = Math.min(
			Math.max(1000, Number.parseInt(c.req.query("windowMs") || "300000", 10) || 300000),
			30 * 60 * 1000, // max 30 minutes
		);

		const events = eventBus.getRecentEvents({ type, limit, windowMs });

		return c.json({
			events,
			count: events.length,
			query: { type: type ?? null, limit, windowMs },
		});
	});

	/**
	 * GET /api/os/events/stream — SSE stream for real-time event subscription.
	 *
	 * Query params:
	 *   ?type=browser.navigate  — filter by event type (default: all)
	 *
	 * Sends events as `data: {...}\n\n` in SSE format.
	 * Sends a heartbeat ping every 30 seconds to keep the connection alive.
	 */
	app.get("/api/os/events/stream", (c) => {
		const filterType = c.req.query("type") || undefined;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			start(controller) {
				const onEvent = (event: SignetOSEvent) => {
					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {
						// Client disconnected — will be cleaned up by abort handler
					}
				};

				// Subscribe to specific type or wildcard
				const subscribeType = filterType ?? "*";
				const sub = eventBus.subscribe(subscribeType, onEvent);

				// Send initial connection event
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: "connected", subscribedTo: subscribeType })}\n\n`,
					),
				);

				// Heartbeat to keep connection alive
				const heartbeat = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
					} catch {
						clearInterval(heartbeat);
					}
				}, 30_000);

				// Cleanup on disconnect
				c.req.raw.signal.addEventListener("abort", () => {
					sub.unsubscribe();
					clearInterval(heartbeat);
				});
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	/**
	 * GET /api/os/context — ambient context snapshot.
	 *
	 * Returns the current rolling window of events, deduped and sorted
	 * by recency. This is what the agent sees.
	 */
	app.get("/api/os/context", (c) => {
		const snapshot = eventBus.getContextSnapshot();
		return c.json(snapshot);
	});

	/**
	 * GET /api/os/events/stats — event bus diagnostics.
	 */
	app.get("/api/os/events/stats", (c) => {
		const stats = eventBus.getStats();
		return c.json(stats);
	});
}
