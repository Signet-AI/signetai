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
