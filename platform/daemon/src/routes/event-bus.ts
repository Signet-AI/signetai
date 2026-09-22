import type { Hono } from "hono";
import type { SignetOSEvent } from "@signet/core";
import { eventBus } from "../event-bus.js";
export function mountEventBusRoutes(app: Hono): void {
	app.get("/api/os/events", (c) => {
		const type = c.req.query("type") || undefined;
		const limit = Math.min(Math.max(1, Number.parseInt(c.req.query("limit") || "50", 10) || 50), 500);
		const windowMs = Math.min(
			Math.max(1000, Number.parseInt(c.req.query("windowMs") || "300000", 10) || 300000),
			30 * 60 * 1000,
		);

		const events = eventBus.getRecentEvents({ type, limit, windowMs });

		return c.json({
			events,
			count: events.length,
			query: { type: type ?? null, limit, windowMs },
		});
	});
	app.get("/api/os/events/stream", (c) => {
		const filterType = c.req.query("type") || undefined;
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			start(controller) {
				const onEvent = (event: SignetOSEvent) => {
					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {}
				};
				const subscribeType = filterType ?? "*";
				const sub = eventBus.subscribe(subscribeType, onEvent);
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ type: "connected", subscribedTo: subscribeType })}\n\n`),
				);
				const heartbeat = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
					} catch {
						clearInterval(heartbeat);
					}
				}, 30_000);
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
	app.get("/api/os/context", (c) => {
		const snapshot = eventBus.getContextSnapshot();
		return c.json(snapshot);
	});
	app.get("/api/os/events/stats", (c) => {
		const stats = eventBus.getStats();
		return c.json(stats);
	});
}
