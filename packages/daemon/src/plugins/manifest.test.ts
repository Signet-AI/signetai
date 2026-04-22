import { describe, expect, test } from "bun:test";
import { signetGraphiqManifest } from "./bundled/graphiq.js";
import { SIGNET_SECRETS_PLUGIN_ID, signetSecretsManifest } from "./bundled/secrets.js";
import { runtimeSupportedInV1, validatePluginManifest } from "./manifest.js";
import type { PluginManifestV1 } from "./types.js";

describe("plugin manifest validation", () => {
	test("accepts the bundled signet.secrets manifest", () => {
		const errors = validatePluginManifest(signetSecretsManifest, { corePluginIds: [SIGNET_SECRETS_PLUGIN_ID] });
		expect(errors).toEqual([]);
	});

	test("accepts the verified managed graphiq manifest", () => {
		expect(validatePluginManifest(signetGraphiqManifest, { corePluginIds: [SIGNET_SECRETS_PLUGIN_ID] })).toEqual([]);
		expect(runtimeSupportedInV1(signetGraphiqManifest)).toBe(true);
	});

	test("does not support verified bundled TypeScript runtime execution", () => {
		const manifest: PluginManifestV1 = {
			...signetGraphiqManifest,
			runtime: {
				language: "typescript",
				kind: "bundled-module",
				entry: "@example/plugin",
			},
		};

		expect(validatePluginManifest(manifest, { corePluginIds: [SIGNET_SECRETS_PLUGIN_ID] })).toEqual([]);
		expect(runtimeSupportedInV1(manifest)).toBe(false);
	});

	test("rejects invalid ids, versions, missing docs, and undeclared surface capabilities", () => {
		const manifest: PluginManifestV1 = {
			...signetSecretsManifest,
			id: "Not Valid",
			version: "one",
			trustTier: "community",
			capabilities: ["secrets:list"],
			surfaces: {
				...signetSecretsManifest.surfaces,
				daemonRoutes: [
					{
						method: "GET",
						path: "/api/example",
						summary: "Example route",
						requiredCapabilities: ["secrets:exec"],
					},
				],
				promptContributions: [],
			},
			docs: { capabilities: {} },
		};

		const errors = validatePluginManifest(manifest, { corePluginIds: [SIGNET_SECRETS_PLUGIN_ID] });
		expect(errors).toContain("id must be dot-delimited lowercase plugin id");
		expect(errors).toContain("version must be SemVer");
		expect(errors).toContain("capability 'secrets:list' is missing docs metadata");
		expect(errors).toContain("surface 'Example route' requires undeclared capability 'secrets:exec'");
		expect(errors).toContain("prompt contribution 'signet.secrets.credential-guidance' is missing surface metadata");
	});
});
