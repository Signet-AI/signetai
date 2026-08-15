import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
	PUBLISH_TARGETS,
	rewritePackageManifest,
	rewritePackageSpecifiers,
	stageNpmPublishPackages,
} from "./stage-npm-publish";

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
				repository: {
					type: "git",
					url: "https://github.com/Signet-AI/signetai.git",
				},
			}),
		);

		const parsed = JSON.parse(staged) as {
			name: string;
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
			repository: { url: string };
		};
		expect(parsed.name).toBe("@signetai/connector-pi");
		expect(parsed.dependencies["@signetai/connector-base"]).toBe("0.140.1");
		expect(parsed.dependencies["@signetai/core"]).toBe("0.140.1");
		expect(parsed.dependencies.zod).toBe("^4.0.0");
		expect(parsed.devDependencies["@signet/sdk"]).toBe("workspace:*");
		expect(parsed.repository.url).toBe("git+https://github.com/Signet-AI/signetai.git");
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

	test("stages every scoped package listed by the nightly publish step", () => {
		const root = join(import.meta.dir, "..");
		const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
		const publishNames = Array.from(
			workflow.matchAll(/publish_npm_package "\$\{STAGED_NPM_ROOT\}\/([^"]+)"/g),
			(match) => match[1],
		)
			.filter((name): name is string => name !== undefined)
			.sort();
		const stagingDir = mkdtempSync(join(tmpdir(), "signet-npm-publish-"));

		try {
			const stagedNames = stageNpmPublishPackages(stagingDir)
				.map((dir) => basename(dir))
				.sort();
			expect(stagedNames).toEqual(publishNames);
			expect(publishNames).toEqual(PUBLISH_TARGETS.map(([, stageName]) => stageName).sort());
			for (const name of publishNames) {
				const manifestFile = join(stagingDir, name, "package.json");
				expect(existsSync(manifestFile)).toBe(true);
				const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { name?: string };
				expect(manifest.name).toMatch(/^@signetai\//);
			}
		} finally {
			rmSync(stagingDir, { force: true, recursive: true });
		}
	});
});
