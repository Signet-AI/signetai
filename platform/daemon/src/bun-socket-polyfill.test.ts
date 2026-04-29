import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Duplex } from "node:stream";
import { applyPolyfill } from "./bun-socket-polyfill";

describe("destroySoon polyfill", () => {
	let originalDestroySoon: typeof Duplex.prototype.destroySoon | undefined;

	beforeEach(() => {
		originalDestroySoon = Duplex.prototype.destroySoon;
		// biome-ignore lint/performance/noDelete: test requires undefined, not a value
		delete (Duplex.prototype as Record<string, unknown>).destroySoon;
	});

	afterEach(() => {
		if (originalDestroySoon) {
			Duplex.prototype.destroySoon = originalDestroySoon;
		}
	});

	test("Duplex lacks destroySoon before polyfill (simulates Bun HTTP socket)", () => {
		const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
		expect(typeof socket.destroySoon).toBe("undefined");
	});

	test("polyfill adds destroySoon to Duplex prototype", () => {
		applyPolyfill();
		const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
		expect(typeof socket.destroySoon).toBe("function");
	});

	test("destroySoon calls end() on writable socket then destroys after finish", async () => {
		applyPolyfill();
		const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });

		let ended = false;
		let destroyed = false;
		socket.on("finish", () => { ended = true; });
		socket.on("close", () => { destroyed = true; });

		socket.destroySoon();

		await new Promise((r) => setTimeout(r, 50));
		expect(ended).toBe(true);
		expect(destroyed).toBe(true);
	});

	test("destroySoon destroys immediately if already finished writing", async () => {
		applyPolyfill();
		const socket = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });

		socket.end();
		await new Promise((r) => socket.once("finish", r));

		let destroyed = false;
		socket.on("close", () => { destroyed = true; });

		socket.destroySoon();
		await new Promise((r) => setTimeout(r, 50));
		expect(destroyed).toBe(true);
	});

	test("polyfill does not overwrite existing destroySoon", () => {
		const sentinel = function sentinel() {};
		Duplex.prototype.destroySoon = sentinel as unknown as typeof Duplex.prototype.destroySoon;

		applyPolyfill();

		expect(Duplex.prototype.destroySoon).toBe(sentinel);
	});
});
