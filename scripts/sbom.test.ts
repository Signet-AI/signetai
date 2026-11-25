import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Advisory, buildSbom, fetchAdvisories, findingsFor, sbomMismatches, sbomPackages } from "./sbom";
import {
	packageRoot,
	packagesFromFiles,
	packagesFromMetafile,
	packagesInTree,
	packagesInlinedBy,
	recordEmbeddedBundle,
	recordShippedPackages,
	shippedArtifacts,
} from "./shipped-packages";

const temporary: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-sbom-"));
	temporary.push(dir);
	return dir;
}

function writePackage(dir: string, name: string, version: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fastUriAdvisories: Advisory[] = [
	{
		url: "https://github.com/advisories/GHSA-f65p-4m7j-42xc",
		title: "fast-uri SSRF via malformed IPv6 normalization",
		severity: "high",
		vulnerable_versions: ">=3.0.0 <3.1.6",
	},
	{
		url: "https://github.com/advisories/GHSA-333x-w4r6-6crp",
		title: "fast-uri scheme injection via an unescaped first-segment colon",
		severity: "low",
		vulnerable_versions: ">=3.0.0 <3.1.9",
	},
];

describe("shipped package records", () => {
	test("resolves the innermost package root in isolated, hoisted, scoped, and Windows layouts", () => {
		expect(packageRoot("/w/node_modules/.bun/fast-uri@3.1.5/node_modules/fast-uri/index.js")).toBe(
			"/w/node_modules/.bun/fast-uri@3.1.5/node_modules/fast-uri",
		);
		expect(packageRoot("/w/node_modules/hono/dist/index.js")).toBe("/w/node_modules/hono");
		expect(
			packageRoot("/w/node_modules/.bun/@hono+node-server@2.1.0/node_modules/@hono/node-server/dist/index.mjs"),
		).toBe("/w/node_modules/.bun/@hono+node-server@2.1.0/node_modules/@hono/node-server");
		expect(packageRoot("C:\\w\\node_modules\\ajv\\node_modules\\fast-uri\\index.js")).toBe(
			"C:/w/node_modules/ajv/node_modules/fast-uri",
		);
		expect(packageRoot("/w/platform/daemon/src/daemon.ts")).toBeNull();
	});

	test("reads bundled packages from metafile inputs relative to the build directory", () => {
		const root = scratch();
		writePackage(join(root, "node_modules/.bun/fast-uri@3.1.5/node_modules/fast-uri"), "fast-uri", "3.1.5");
		writePackage(join(root, "node_modules/.bun/@scope+lib@1.0.0/node_modules/@scope/lib"), "@scope/lib", "1.0.0");
		const metafile = JSON.stringify({
			inputs: {
				"../../node_modules/.bun/fast-uri@3.1.5/node_modules/fast-uri/index.js": {},
				"../../node_modules/.bun/fast-uri@3.1.5/node_modules/fast-uri/lib/utils.js": {},
				"../../node_modules/.bun/@scope+lib@1.0.0/node_modules/@scope/lib/dist/index.js": {},
				"src/daemon.ts": {},
			},
		});
		expect(packagesFromMetafile(metafile, join(root, "platform", "daemon"))).toEqual([
			{ name: "fast-uri", version: "3.1.5" },
			{ name: "@scope/lib", version: "1.0.0" },
		]);
	});

	test("skips virtual modules and query suffixes from Vite module ids", () => {
		const root = scratch();
		writePackage(join(root, "node_modules/react"), "react", "19.2.0");
		expect(
			packagesFromFiles(["\0vite/preload-helper.js", `${root}/node_modules/react/index.js?commonjs-proxy`], root),
		).toEqual([{ name: "react", version: "19.2.0" }]);
	});

	test("fails instead of recording an input whose package manifest is missing", () => {
		const root = scratch();
		mkdirSync(join(root, "node_modules/ghost"), { recursive: true });
		expect(() => packagesFromMetafile({ inputs: { "node_modules/ghost/index.js": {} } }, root)).toThrow();
		expect(() => packagesFromMetafile({ outputs: {} }, root)).toThrow("no inputs");
		expect(() => packagesFromMetafile(undefined, root)).toThrow("no inputs");
	});

	test("follows prebuilt workspace bundles and embedded bundles to the packages inside them", () => {
		const root = scratch();
		writePackage(join(root, "node_modules/.bun/libsodium@0.8.4/node_modules/libsodium"), "libsodium", "0.8.4");
		writePackage(join(root, "node_modules/.bun/zod@4.6.7/node_modules/zod"), "zod", "4.6.7");
		writePackage(join(root, "platform/core"), "@signet/core", "1.0.2");
		mkdirSync(join(root, "platform/core/dist"), { recursive: true });
		mkdirSync(join(root, "platform/core/.bundle-inputs"), { recursive: true });
		writeFileSync(
			join(root, "platform/core/.bundle-inputs/bundle.json"),
			JSON.stringify({
				outputs: {
					"./index.js": {
						inputs: {
							"src/index.ts": {},
							"../../node_modules/.bun/libsodium@0.8.4/node_modules/libsodium/dist/sodium.js": {},
						},
					},
				},
			}),
		);
		writePackage(join(root, "integrations/pi/extension"), "@signet/pi-extension", "1.0.2");
		mkdirSync(join(root, "integrations/pi/extension/.bundle-inputs"), { recursive: true });
		writeFileSync(
			join(root, "integrations/pi/extension/.bundle-inputs/bundle.json"),
			JSON.stringify({
				outputs: {
					"./signet-pi.mjs": {
						inputs: {
							"../../../platform/core/dist/index.js": {},
							"../../../node_modules/.bun/zod@4.6.7/node_modules/zod/index.js": {},
						},
					},
				},
			}),
		);
		const connector = join(root, "integrations/pi/connector");
		writePackage(connector, "@signet/connector-pi", "1.0.2");
		recordEmbeddedBundle(connector, join(connector, "src/extension-bundle.ts"), [
			join(root, "integrations/pi/extension/dist/signet-pi.mjs"),
		]);
		const metafile = {
			inputs: { "integrations/pi/connector/src/extension-bundle.ts": {}, "platform/daemon/src/x.ts": {} },
		};
		expect(
			packagesFromMetafile(metafile, root)
				.map((item) => `${item.name}@${item.version}`)
				.sort(),
		).toEqual(["libsodium@0.8.4", "zod@4.6.7"]);
	});

	test("refuses a prebuilt workspace bundle whose inputs were not recorded", () => {
		const root = scratch();
		writePackage(join(root, "platform/core"), "@signet/core", "1.0.2");
		expect(() => packagesFromMetafile({ inputs: { "platform/core/dist/index.js": {} } }, root)).toThrow(
			"prebuilt bundle with no recorded inputs",
		);
		expect(packagesFromMetafile({ inputs: { "platform/core/src/index.ts": {} } }, root)).toEqual([]);
	});

	test("refuses an embedded bundle without a record and an output recorded twice", () => {
		const root = scratch();
		const connector = join(root, "integrations/pi/connector");
		writePackage(connector, "@signet/connector-pi", "1.0.2");
		expect(() =>
			packagesFromMetafile({ inputs: { "integrations/pi/connector/src/extension-bundle.ts": {} } }, root),
		).toThrow("prebuilt bundle with no recorded inputs");
		expect(() => recordEmbeddedBundle(connector, join(connector, "src/extension.ts"), [])).toThrow("must end in");

		writePackage(join(root, "platform/core"), "@signet/core", "1.0.2");
		mkdirSync(join(root, "platform/core/.bundle-inputs"), { recursive: true });
		for (const name of ["bundle.json", "old.json"]) {
			writeFileSync(
				join(root, "platform/core/.bundle-inputs", name),
				JSON.stringify({ outputs: { "./index.js": { inputs: {} } } }),
			);
		}
		expect(() => packagesFromMetafile({ inputs: { "platform/core/dist/index.js": {} } }, root)).toThrow(
			"is recorded by both",
		);
	});

	test("a nameless nested package.json does not hide the workspace bundle", () => {
		const root = scratch();
		writePackage(join(root, "node_modules/fast-uri"), "fast-uri", "3.1.9");
		writePackage(join(root, "platform/core"), "@signet/core", "1.0.2");
		mkdirSync(join(root, "platform/core/dist"), { recursive: true });
		writeFileSync(join(root, "platform/core/dist/package.json"), JSON.stringify({ type: "module" }));
		mkdirSync(join(root, "platform/core/.bundle-inputs"), { recursive: true });
		writeFileSync(
			join(root, "platform/core/.bundle-inputs/bundle.json"),
			JSON.stringify({ outputs: { "./index.js": { inputs: { "../../node_modules/fast-uri/index.js": {} } } } }),
		);
		expect(packagesFromMetafile({ inputs: { "platform/core/dist/index.js": {} } }, root)).toEqual([
			{ name: "fast-uri", version: "3.1.9" },
		]);
	});

	test("reads the packages an upstream bundle inlined from its store paths", () => {
		const source = [
			"// node_modules/.pnpm/@huggingface+jinja@0.5.6/node_modules/@huggingface/jinja/dist/index.js",
			"// node_modules/.pnpm/@huggingface+tokenizers@0.1.3/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs",
			"// node_modules/.bun/fast-uri@3.1.5+a1b2c3/node_modules/fast-uri/index.js",
			"// node_modules/.pnpm/react-dom@19.2.0_react@19.2.0/node_modules/react-dom/index.js",
			"// node_modules/.pnpm/@huggingface+jinja@0.5.6/node_modules/@huggingface/jinja/dist/other.js",
		].join("\n");
		expect(packagesInlinedBy(source)).toEqual([
			{ name: "@huggingface/jinja", version: "0.5.6" },
			{ name: "@huggingface/tokenizers", version: "0.1.3" },
			{ name: "fast-uri", version: "3.1.5" },
			{ name: "react-dom", version: "19.2.0" },
		]);
		expect(packagesInlinedBy("export const x = 1;")).toEqual([]);
	});

	test("walks vendored node_modules including scoped and nested packages", () => {
		const root = scratch();
		writePackage(join(root, "node_modules/@firecrawl/anydoc"), "@firecrawl/anydoc", "0.4.0");
		writePackage(join(root, "node_modules/@firecrawl/anydoc/node_modules/tar"), "tar", "7.5.22");
		writePackage(join(root, "node_modules/anydoc-linux-x64-gnu"), "anydoc-linux-x64-gnu", "0.4.0");
		expect(
			packagesInTree(root)
				.map((item) => `${item.name}@${item.version}`)
				.sort(),
		).toEqual(["@firecrawl/anydoc@0.4.0", "anydoc-linux-x64-gnu@0.4.0", "tar@7.5.22"]);
	});
});

describe("sbom", () => {
	test("refuses to describe a release when an artifact was not recorded", () => {
		const dir = scratch();
		recordShippedPackages("daemon", [{ name: "hono", version: "4.13.22" }], dir);
		expect(() => buildSbom(dir, "1.0.2")).toThrow("Missing shipped package records for: daemon-js-vendor");
	});

	test("refuses an empty artifact record", () => {
		const dir = scratch();
		for (const artifact of shippedArtifacts)
			recordShippedPackages(artifact, [{ name: "hono", version: "4.13.22" }], dir);
		writeFileSync(join(dir, "dashboard.json"), "[]\n");
		expect(() => buildSbom(dir, "1.0.2")).toThrow("dashboard.json is not a non-empty package list");
	});

	test("lists every shipped package once with the artifacts that contain it", () => {
		const dir = scratch();
		for (const artifact of shippedArtifacts) {
			recordShippedPackages(artifact, [{ name: "@scope/shared", version: "1.0.0" }], dir);
		}
		recordShippedPackages(
			"signet-mcp",
			[
				{ name: "@scope/shared", version: "1.0.0" },
				{ name: "fast-uri", version: "3.1.9" },
			],
			dir,
		);
		const sbom = buildSbom(dir, "1.0.2");
		const written = JSON.parse(JSON.stringify(sbom));
		expect(written.bomFormat).toBe("CycloneDX");
		expect(written.metadata.component).toMatchObject({ name: "signetai", version: "1.0.2" });
		expect(written.components.map((component: { purl: string }) => component.purl)).toEqual([
			"pkg:npm/%40scope/shared@1.0.0",
			"pkg:npm/fast-uri@3.1.9",
		]);
		expect(written.components[1].properties).toEqual([{ name: "signet:artifact", value: "signet-mcp" }]);
		expect(written.components[0].properties).toHaveLength(shippedArtifacts.length);
		expect(sbomPackages(written)).toEqual([
			{ name: "@scope/shared", version: "1.0.0" },
			{ name: "fast-uri", version: "3.1.9" },
		]);
	});
});

describe("sbom verify", () => {
	test("passes when this build matches the audited SBOM and lists each difference otherwise", () => {
		const audited = scratch();
		for (const artifact of shippedArtifacts)
			recordShippedPackages(artifact, [{ name: "hono", version: "4.13.22" }], audited);
		recordShippedPackages(
			"daemon-js-vendor",
			[
				{ name: "@firecrawl/anydoc", version: "0.4.0" },
				{ name: "anydoc-linux-x64-gnu", version: "0.4.0" },
			],
			audited,
		);
		const sbom = JSON.parse(JSON.stringify(buildSbom(audited, "1.0.2")));

		const publish = scratch();
		recordShippedPackages("signet-mcp", [{ name: "hono", version: "4.13.22" }], publish);
		recordShippedPackages(
			"daemon-js-vendor",
			[
				{ name: "@firecrawl/anydoc", version: "0.4.0" },
				{ name: "anydoc-linux-x64-gnu", version: "0.4.0" },
			],
			publish,
		);
		expect(sbomMismatches(sbom, publish)).toEqual([]);

		recordShippedPackages(
			"daemon-js-vendor",
			[
				{ name: "@firecrawl/anydoc", version: "0.4.0" },
				{ name: "anydoc-darwin-arm64", version: "0.4.0" },
			],
			publish,
		);
		expect(sbomMismatches(sbom, publish)).toEqual([
			"daemon-js-vendor: pkg:npm/anydoc-darwin-arm64@0.4.0 was built but not audited",
			"daemon-js-vendor: pkg:npm/anydoc-linux-x64-gnu@0.4.0 was audited but not built",
		]);
		expect(() => sbomMismatches(sbom, scratch())).toThrow("No shipped package records");
	});
});

describe("advisory audit", () => {
	test("flags the bundled fast-uri from #2294 and clears the fixed release", () => {
		const advisories = new Map([["fast-uri", fastUriAdvisories]]);
		const vulnerable = findingsFor([{ name: "fast-uri", version: "3.1.5" }], advisories);
		expect(vulnerable.map((finding) => finding.severity)).toEqual(["high", "low"]);
		expect(findingsFor([{ name: "fast-uri", version: "3.1.9" }], advisories)).toEqual([]);
	});

	test("batches registry lookups and fails closed on a bad response", async () => {
		const bodies: Record<string, unknown>[] = [];
		const packages = Array.from({ length: 150 }, (_, index) => ({ name: `pkg-${index}`, version: "1.0.0" }));
		const ok: typeof fetch = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				return Response.json({ "pkg-1": fastUriAdvisories });
			},
			{ preconnect: fetch.preconnect },
		);
		const result = await fetchAdvisories(packages, ok);
		expect(bodies.map((body) => Object.keys(body).length)).toEqual([100, 50]);
		expect(result.get("pkg-1")).toHaveLength(2);

		const failing: typeof fetch = Object.assign(async () => new Response("nope", { status: 503 }), {
			preconnect: fetch.preconnect,
		});
		await expect(fetchAdvisories(packages, failing)).rejects.toThrow("HTTP 503");
		const malformed: typeof fetch = Object.assign(async () => Response.json({ "pkg-1": [{ severity: "urgent" }] }), {
			preconnect: fetch.preconnect,
		});
		await expect(fetchAdvisories(packages, malformed)).rejects.toThrow("Invalid advisory");
	});
});

test("root overrides are floors that let fixes through, not exact pins", () => {
	const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
	const ranges = (overrides: object, path: string): [string, unknown][] =>
		Object.entries(overrides).flatMap(([name, value]): [string, unknown][] =>
			typeof value === "object" && value !== null ? ranges(value, `${path}${name} > `) : [[`${path}${name}`, value]],
		);
	for (const [name, range] of ranges(manifest.overrides ?? {}, "")) {
		expect({ name, exact: typeof range !== "string" || /^\d/.test(range) }).toEqual({ name, exact: false });
	}
});
