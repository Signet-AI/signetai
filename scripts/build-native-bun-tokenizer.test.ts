import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function smoke(addon: string): ReturnType<typeof spawnSync> {
	const directory = mkdtempSync(join(tmpdir(), "signet-native-tokenizer-smoke-test-"));
	try {
		const path = join(directory, "addon.cjs");
		writeFileSync(path, addon);
		const script = readFileSync(join(import.meta.dir, "build-native-bun.ts"), "utf8");
		const raw = script
			.split("} else if (process.env.SIGNET_NATIVE_TOKENIZER_SMOKE) {", 2)[1]
			?.split("} else if (process.env.SIGNET_RUNTIME_VERSION_SMOKE) {", 1)[0];
		if (!raw) throw new Error("Missing compiled tokenizer smoke branch");
		const branch = String(new Function(`return \`${raw}\`;`)());
		return spawnSync(
			process.execPath,
			[
				"--eval",
				`
			import { join } from "node:path";
			const materializeEmbeddedNativeAddon = () => ${JSON.stringify(path)};
			${branch}
		`,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("compiled native tokenizer smoke", () => {
	test("reports success only after constructing a tokenizer file and encoding its pair", () => {
		const result = smoke(`module.exports.PairTokenizer = class {
			constructor(path, maxLength) {
				const json = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
				if (!json.model || maxLength !== 512) throw new Error("missing tokenizer model");
			}
			encodePairs(query, documents) {
				if (query !== "alpha" || JSON.stringify(documents) !== '["beta"]') throw new Error("unexpected pair");
				return { batchSize: 1, sequenceLength: 5, inputIds: [1,4,2,5,2], attentionMask: [1,1,1,1,1], tokenTypeIds: [0,0,0,1,1] };
			}
		};`);
		expect(result.status).toBe(0);
		expect(JSON.parse(String(result.stdout))).toEqual({
			type: "native-tokenizer",
			pairTokenizer: true,
			batchSize: 1,
			sequenceLength: 5,
		});
	});

	test.each(["constructor", "encoding"])("fails release verification when %s fails", (failure) => {
		const result = smoke(`module.exports.PairTokenizer = class {
			constructor() { ${failure === "constructor" ? 'throw new Error("constructor failed")' : ""} }
			encodePairs() { throw new Error("encoding failed"); }
		};`);
		expect(result.status).not.toBe(0);
		expect(String(result.stderr)).toContain(`${failure} failed`);
	});
});
