import { Duplex } from "node:stream";

declare module "node:stream" {
	interface Duplex {
		destroySoon(): void;
	}
}

export function applyPolyfill(): void {
	if (typeof Duplex.prototype.destroySoon === "function") return;
	Duplex.prototype.destroySoon = function destroySoon() {
		if (this.writable) this.end();
		if (this.writableFinished) this.destroy();
		else this.once("finish", this.destroy);
	};
}

applyPolyfill();
