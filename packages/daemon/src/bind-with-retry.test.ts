import { describe, expect, it } from "bun:test";
import { type Server, createServer } from "node:net";
import { bindWithRetry } from "./bind-with-retry";

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

describe("bindWithRetry", () => {
	it("binds successfully on first attempt when port is free", async () => {
		const port = await freePort();
		let bound: Server | null = null;
		let listened = false;

		await new Promise<void>((resolve) => {
			bindWithRetry({
				port,
				hostname: "127.0.0.1",
				createServer: () => createServer(),
				onBound: (server) => {
					bound = server;
				},
				onListening: () => {
					listened = true;
					resolve();
				},
			});
		});

		expect(bound).not.toBeNull();
		expect(listened).toBe(true);
		bound?.close();
	});

	it("retries on EADDRINUSE and succeeds when port is released", async () => {
		const port = await freePort();

		// Occupy the port
		const blocker = createServer();
		await new Promise<void>((resolve) => {
			blocker.listen(port, "127.0.0.1", () => resolve());
		});

		let attempts = 0;
		const scheduledDelays: number[] = [];
		let bound: Server | null = null;

		await new Promise<void>((resolve) => {
			bindWithRetry({
				port,
				hostname: "127.0.0.1",
				baseDelayMs: 10,
				createServer: () => {
					attempts++;
					return createServer();
				},
				onBound: (server) => {
					bound = server;
				},
				onListening: () => {
					resolve();
				},
				schedule: (fn, ms) => {
					scheduledDelays.push(ms);
					// Release the port before the next attempt
					if (blocker.listening) {
						blocker.close(() => setTimeout(fn, 5));
					} else {
						setTimeout(fn, 5);
					}
				},
			});
		});

		expect(attempts).toBeGreaterThan(1);
		expect(scheduledDelays.length).toBeGreaterThanOrEqual(1);
		expect(scheduledDelays[0]).toBe(10);
		expect(bound).not.toBeNull();
		bound?.close();
	});

	it("retries indefinitely on persistent EADDRINUSE without crashing", async () => {
		const port = await freePort();

		const blocker = createServer();
		await new Promise<void>((resolve) => {
			blocker.listen(port, "127.0.0.1", () => resolve());
		});

		let attempts = 0;
		let fatalCalled = false;
		const scheduledDelays: number[] = [];

		await new Promise<void>((resolve) => {
			bindWithRetry({
				port,
				hostname: "127.0.0.1",
				baseDelayMs: 10,
				maxDelayMs: 80,
				createServer: () => {
					attempts++;
					return createServer();
				},
				onBound: () => {},
				onListening: () => {},
				onFatalError: () => {
					fatalCalled = true;
				},
				schedule: (fn, ms) => {
					scheduledDelays.push(ms);
					// Stop after 6 attempts to end the test
					if (attempts >= 6) {
						resolve();
					} else {
						setTimeout(fn, 1);
					}
				},
			});
		});

		// Should have retried at least 6 times without calling onFatalError
		expect(attempts).toBeGreaterThanOrEqual(6);
		expect(fatalCalled).toBe(false);

		blocker.close();
	});

	it("caps delay at maxDelayMs with exponential backoff", async () => {
		const port = await freePort();

		const blocker = createServer();
		await new Promise<void>((resolve) => {
			blocker.listen(port, "127.0.0.1", () => resolve());
		});

		const scheduledDelays: number[] = [];
		let attempts = 0;

		await new Promise<void>((resolve) => {
			bindWithRetry({
				port,
				hostname: "127.0.0.1",
				baseDelayMs: 100,
				maxDelayMs: 500,
				createServer: () => {
					attempts++;
					return createServer();
				},
				onBound: () => {},
				onListening: () => {},
				schedule: (fn, ms) => {
					scheduledDelays.push(ms);
					if (attempts >= 5) {
						resolve();
					} else {
						setTimeout(fn, 1);
					}
				},
			});
		});

		// Delays: 100, 200, 400, 500 (capped), 500 (capped)
		expect(scheduledDelays[0]).toBe(100);
		expect(scheduledDelays[1]).toBe(200);
		expect(scheduledDelays[2]).toBe(400);
		expect(scheduledDelays[3]).toBe(500);

		blocker.close();
	});

	it("calls onFatalError for non-EADDRINUSE errors", async () => {
		let fatalError: Error | null = null;

		// Create a server that emits a non-EADDRINUSE error
		bindWithRetry({
			port: 0,
			hostname: "127.0.0.1",
			createServer: () => {
				const server = createServer();
				// Simulate a non-EADDRINUSE error after listen attempt
				process.nextTick(() => {
					const err = new Error("test error") as NodeJS.ErrnoException;
					err.code = "EACCES";
					server.emit("error", err);
				});
				// Override listen to no-op so it doesn't actually bind
				server.listen = (() => server) as typeof server.listen;
				return server;
			},
			onBound: () => {},
			onListening: () => {},
			onFatalError: (err) => {
				fatalError = err;
			},
		});

		// Wait for nextTick
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(fatalError).not.toBeNull();
		expect((fatalError as NodeJS.ErrnoException).code).toBe("EACCES");
	});

	it("stops retrying when signal is aborted", async () => {
		const port = await freePort();

		const blocker = createServer();
		await new Promise<void>((resolve) => {
			blocker.listen(port, "127.0.0.1", () => resolve());
		});

		const controller = new AbortController();
		let attempts = 0;

		await new Promise<void>((resolve) => {
			bindWithRetry({
				port,
				hostname: "127.0.0.1",
				baseDelayMs: 10,
				signal: controller.signal,
				createServer: () => {
					attempts++;
					return createServer();
				},
				onBound: () => {},
				onListening: () => {},
				schedule: (fn, _ms) => {
					// Abort after the first retry is scheduled
					controller.abort();
					// Still call fn — the guard inside bindWithRetry should bail
					const timer = setTimeout(fn, 1);
					return timer;
				},
			});

			// Wait for the scheduled fn to fire and be guarded
			setTimeout(() => resolve(), 100);
		});

		// First attempt fails (EADDRINUSE), schedules retry, abort fires,
		// retry enters bindWithRetry but bails at the signal check.
		// So we get exactly 2 createServer calls: attempt 0 + attempt 1 (bailed).
		expect(attempts).toBeLessThanOrEqual(2);

		blocker.close();
	});

	it("does not start if signal is already aborted", () => {
		const controller = new AbortController();
		controller.abort();

		let attempts = 0;

		bindWithRetry({
			port: 0,
			hostname: "127.0.0.1",
			signal: controller.signal,
			createServer: () => {
				attempts++;
				return createServer();
			},
			onBound: () => {},
			onListening: () => {},
		});

		expect(attempts).toBe(0);
	});
});
