import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonRouteTarget, isDaemonRouteUrl } from "./protocol-routes";

describe("desktop protocol daemon routes", () => {
	test("recognizes daemon API routes loaded through app protocol", () => {
		expect(isDaemonRouteUrl("app://signet/health")).toBe(true);
		expect(isDaemonRouteUrl("app://signet/api/memories?limit=1")).toBe(true);
		expect(isDaemonRouteUrl("app://signet/memory/search?q=test")).toBe(true);
		expect(isDaemonRouteUrl("app://signet/assets/index.js")).toBe(false);
		expect(isDaemonRouteUrl("app://signet/")).toBe(false);
	});

	test("preserves path and query when proxying to the daemon", () => {
		expect(daemonRouteTarget("http://localhost:3850/", "app://signet/api/memories?limit=1")).toBe(
			"http://localhost:3850/api/memories?limit=1",
		);
	});

	test("serves packaged dashboard files through Electron net.fetch", () => {
		const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

		expect(mainSource).toContain("net.fetch(pathToFileURL(file).toString())");
		expect(mainSource).not.toContain("new Response(await readFile(file)");
	});
});
