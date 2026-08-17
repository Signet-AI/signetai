import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	getNativeTransformersBindings,
	materializeEmbeddedAssetTree,
	materializeEmbeddedNativeAddon,
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
			workers: [{ name: "example-worker", contentBase64: Buffer.from("export default 1;").toString("base64") }],
			wasm: [{ name: "example.wasm", contentBase64: Buffer.from("wasm-bytes").toString("base64") }],
		});

		const workerPath = resolveEmbeddedWorkerPath("example-worker");
		expect(workerPath).toBeTruthy();
		expect(workerPath?.endsWith(".mjs")).toBe(true);
		expect(workerPath ? readFileSync(workerPath, "utf8") : "").toBe("export default 1;");

		const wasmDir = materializeEmbeddedWasmAssets();
		expect(wasmDir).toBeTruthy();
		expect(wasmDir ? existsSync(`${wasmDir}/example.wasm`) : false).toBe(true);
	});

	test("materializes an embedded native addon to a real .node file, returning null when absent", () => {
		expect(materializeEmbeddedNativeAddon("napi-rs-keyring")).toBeNull();

		registerNativeAssets({
			nativeAddons: [{ name: "napi-rs-keyring", contentBase64: Buffer.from("fake-native-binding").toString("base64") }],
		});

		const addonPath = materializeEmbeddedNativeAddon("napi-rs-keyring");
		expect(addonPath).toBeTruthy();
		expect(addonPath?.endsWith(".node")).toBe(true);
		expect(addonPath ? readFileSync(addonPath, "utf8") : "").toBe("fake-native-binding");
		const concurrentPaths = Array.from({ length: 16 }, () => materializeEmbeddedNativeAddon("napi-rs-keyring"));
		expect(new Set(concurrentPaths).size).toBe(1);
		expect(concurrentPaths[0] ? readFileSync(concurrentPaths[0], "utf8") : "").toBe("fake-native-binding");
		expect(materializeEmbeddedNativeAddon("missing-addon")).toBeNull();
	});

	test("fences valid differently-hashed addons during sweep and removes corrupt strays", () => {
		const contentA = Buffer.from("newer-content");
		const contentB = Buffer.from("older-content");
		registerNativeAssets({ nativeAddons: [{ name: "fenced-addon", contentBase64: contentA.toString("base64") }] });
		const pathA = materializeEmbeddedNativeAddon("fenced-addon");
		expect(pathA).toBeTruthy();
		registerNativeAssets({ nativeAddons: [{ name: "fenced-addon", contentBase64: contentB.toString("base64") }] });
		const pathB = materializeEmbeddedNativeAddon("fenced-addon");
		expect(pathB).toBeTruthy();
		expect(pathA).not.toBe(pathB);
		expect(pathA ? readFileSync(pathA) : null).toEqual(contentA);
		expect(pathB ? readFileSync(pathB) : null).toEqual(contentB);

		const dir = join(tmpdir(), "signet-native-addons");
		const corrupt = join(dir, "fenced-addon-deadbeefdeadbeef.node");
		const stray = join(dir, "fenced-addon-stray.tmp");
		writeFileSync(corrupt, "torn");
		writeFileSync(stray, "temp");
		materializeEmbeddedNativeAddon("fenced-addon");
		expect(pathA ? existsSync(pathA) : false).toBe(true);
		expect(pathB ? existsSync(pathB) : false).toBe(true);
		expect(existsSync(corrupt)).toBe(false);
		expect(existsSync(stray)).toBe(false);
		expect(readdirSync(dir).some((entry) => entry.startsWith("fenced-addon-") && entry.endsWith(".node"))).toBe(true);
	});

	test("materializes embedded setup asset trees", () => {
		registerNativeAssets({
			templates: [
				{
					path: "memory/scripts/memory.py",
					contentBase64: Buffer.from("print('memory')\n").toString("base64"),
					mode: 0o644,
				},
			],
			skills: [
				{
					path: "signet/SKILL.md",
					contentBase64: Buffer.from("# Signet\n").toString("base64"),
					mode: 0o644,
				},
			],
		});

		const templatesDir = materializeEmbeddedAssetTree("templates");
		const skillsDir = materializeEmbeddedAssetTree("skills");
		expect(templatesDir ? readFileSync(`${templatesDir}/memory/scripts/memory.py`, "utf8") : "").toContain("memory");
		expect(skillsDir ? readFileSync(`${skillsDir}/signet/SKILL.md`, "utf8") : "").toContain("Signet");
	});

	test("materializes connector assets under a deterministic hash with a content marker", () => {
		registerNativeAssets({
			connectors: [
				{
					path: "hermes-agent/hermes-plugin/__init__.py",
					contentBase64: Buffer.from("# signet provider\n").toString("base64"),
					mode: 0o644,
				},
			],
		});

		const first = materializeEmbeddedAssetTree("connectors");
		const second = materializeEmbeddedAssetTree("connectors");
		expect(first).toBe(second);
		expect(first ? readFileSync(`${first}/hermes-agent/hermes-plugin/__init__.py`, "utf8") : "").toBe(
			"# signet provider\n",
		);
		const marker = JSON.parse(first ? readFileSync(`${first}/.signet-assets.json`, "utf8") : "{}") as {
			kind?: unknown;
			sourceHash?: unknown;
		};
		expect(marker.kind).toBe("connectors");
		expect(marker.sourceHash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("stores pre-resolved transformers bindings for compiled runtime", () => {
		const bindings = { env: {}, pipeline: () => undefined };
		registerNativeTransformersBindings(bindings);
		expect(getNativeTransformersBindings()).toBe(bindings);
	});
});
