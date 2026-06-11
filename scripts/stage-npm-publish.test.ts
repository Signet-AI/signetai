import { describe, expect, test } from "bun:test";

import { rewritePackageManifest, rewritePackageSpecifiers } from "./stage-npm-publish";

describe("stage-npm-publish", () => {
	test("rewrites only staged npm package names and dependencies to the signetai scope", () => {
		const staged = rewritePackageManifest(
			JSON.stringify({
				name: "@signet/connector-pi",
				dependencies: {
					"@signet/connector-base": "0.140.1",
					"@signet/core": "0.140.1",
					zod: "^4.0.0",
				},
				devDependencies: {
					"@signet/sdk": "workspace:*",
				},
			}),
		);

		const parsed = JSON.parse(staged) as {
			name: string;
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(parsed.name).toBe("@signetai/connector-pi");
		expect(parsed.dependencies["@signetai/connector-base"]).toBe("0.140.1");
		expect(parsed.dependencies["@signetai/core"]).toBe("0.140.1");
		expect(parsed.dependencies.zod).toBe("^4.0.0");
		expect(parsed.devDependencies["@signet/sdk"]).toBe("workspace:*");
	});

	test("rewrites staged installer imports and help text", () => {
		expect(
			rewritePackageSpecifiers(
				'import { runConnectorInstaller } from "@signet/connector-base";\n' +
					"npx -y @signet/connector-pi install\n" +
					"`@signet/connector-${harness}`\n",
			),
		).toBe(
			'import { runConnectorInstaller } from "@signetai/connector-base";\n' +
				"npx -y @signetai/connector-pi install\n" +
				"`@signetai/connector-${harness}`\n",
		);
	});
});
