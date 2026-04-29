/**
 * Polyfill for Bun's NodeHTTPServerSocket missing `destroySoon()`.
 *
 * Bun's HTTP server socket wrapper extends Duplex but omits destroySoon().
 * @hono/node-server ≥1.19.13 calls it in its drain handler, crashing the
 * daemon on any unconsumed POST body.
 *
 * Semantics match Node.js net.Socket.destroySoon() exactly:
 * https://github.com/nodejs/node/blob/main/lib/net.js#L785
 *
 * Tracks: https://github.com/oven-sh/bun/issues/24127
 * Remove when Bun ships PR #26264.
 */
import { Duplex } from "node:stream";

export function applyPolyfill(): void {
	if (typeof Duplex.prototype.destroySoon === "function") return;
	Duplex.prototype.destroySoon = function destroySoon() {
		if (this.writable) this.end();
		if (this.writableFinished) this.destroy();
		else this.once("finish", this.destroy);
	};
}

applyPolyfill();
