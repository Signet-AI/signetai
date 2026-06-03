import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	getNativeTransformersBindings,
	materializeEmbeddedWasmAssets,
	registerNativeAssets,
	registerNativeTransformersBindings,
	resolveEmbeddedDashboardAsset,
	resolveEmbeddedWorkerPath,
} from "./native-runtime-assets";

afterEach(() => {
	globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__ = undefined;
	globalThis.__SIGNET_NATIVE_TRANSFORMERS_BINDINGS__ = undefined;
});

describe("native-runtime-assets", () => {
	test("resolves embedded dashboard routes with SPA fallback", () => {
		registerNativeAssets({
			dashboard: [
				{
					path: "/index.html",
					contentType: "text/html; charset=utf-8",
					contentBase64: Buffer.from("<html>Signet</html>").toString("base64"),
				},
				{
					path: "/_app/app.js",
					contentType: "text/javascript; charset=utf-8",
					contentBase64: Buffer.from("console.log('ok')").toString("base64"),
				},
			],
		});

		expect(resolveEmbeddedDashboardAsset("/")?.path).toBe("/index.html");
		expect(resolveEmbeddedDashboardAsset("/memory")?.path).toBe("/index.html");
		expect(resolveEmbeddedDashboardAsset("/_app/app.js")?.contentType).toBe("text/javascript; charset=utf-8");
		expect(resolveEmbeddedDashboardAsset("/missing.png")).toBeNull();
	});

	test("materializes embedded worker and wasm files", () => {
		registerNativeAssets({
			workers: [{ name: "example-worker", contentBase64: Buffer.from("module.exports = 1;").toString("base64") }],
			wasm: [{ name: "example.wasm", contentBase64: Buffer.from("wasm-bytes").toString("base64") }],
		});

		const workerPath = resolveEmbeddedWorkerPath("example-worker");
		expect(workerPath).toBeTruthy();
		expect(workerPath ? readFileSync(workerPath, "utf8") : "").toBe("module.exports = 1;");

		const wasmDir = materializeEmbeddedWasmAssets();
		expect(wasmDir).toBeTruthy();
		expect(wasmDir ? existsSync(`${wasmDir}/example.wasm`) : false).toBe(true);
	});

	test("stores pre-resolved transformers bindings for compiled runtime", () => {
		const bindings = { env: {}, pipeline: () => undefined };
		registerNativeTransformersBindings(bindings);
		expect(getNativeTransformersBindings()).toBe(bindings);
	});
});
