/**
 * Regression guard for the compiled-binary transformers web-runtime patch
 * (scripts/build-native-bun.ts). The transformers 4.2.0 bump broke native
 * embedding in the compiled binary via four anchors the patcher now rewrites
 * with unique-match guards:
 *
 *   1. DEFAULT_DEVICE — selectDevice() null-device default; without the
 *      wasm pin the binary throws `Unsupported device: "cpu". Should be one
 *      of: wasm.` (the release smoke failed on every platform with this).
 *   2. node:fs/path/url stubs — the web build ships them as empty objects,
 *      forcing env.useFS=false so getFile() fetches bare filesystem paths.
 *   3. return_path = apis.IS_NODE_ENV — makes transformers hand the onnx
 *      model to onnxruntime by PATH, which the 1.26 glue fetch()es.
 *   4. getCoreModelFile's direct apis.IS_NODE_ENV return_path argument.
 *
 * If a transformers bump restructures any anchor, the patcher already fails
 * loudly at build time; this test surfaces the same drift at test time so
 * every PR (not just release runs) catches it. Anchors must each appear
 * exactly once, mirroring the patcher's guards.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const daemonRequire = createRequire(join(import.meta.dir, "..", "platform", "daemon", "package.json"));
const transformersPackageJson = daemonRequire.resolve("@huggingface/transformers/package.json");
const transformersWebRuntimePath = join(dirname(transformersPackageJson), "dist", "transformers.web.js");
const source = readFileSync(transformersWebRuntimePath, "utf8");

const ANCHORS = [
	'var DEFAULT_DEVICE = apis.IS_NODE_ENV ? "cpu" : "wasm";',
	"// ignore-modules:node:fs\nvar node_fs_default = {};",
	"// ignore-modules:node:path\nvar node_path_default = {};",
	"// ignore-modules:node:url\nvar node_url_default = {};",
	"const return_path = apis.IS_NODE_ENV;",
	"return await getModelFile(pretrained_model_name_or_path, fullPath, true, options, apis.IS_NODE_ENV);",
];

describe("native transformers web-runtime patch contract", () => {
	test("every patcher anchor appears exactly once in the installed runtime", () => {
		for (const anchor of ANCHORS) {
			expect(source.split(anchor).length - 1, anchor).toBe(1);
		}
	});
});
