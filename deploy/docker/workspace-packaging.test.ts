import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const dockerfile = readFileSync(resolve(repo, "deploy/docker/Dockerfile"), "utf8");
const dockerignore = readFileSync(resolve(repo, ".dockerignore"), "utf8");

for (const workspace of [
	"libs",
	"integrations",
	"memorybench",
	"platform/core",
	"platform/native",
	"surfaces",
	"web",
]) {
	test(`Docker build context packages ${workspace} workspace sources`, () => {
		expect(dockerfile).toContain(`COPY ${workspace} ./`);
	});
}

test("Docker build context does not exclude workspace source trees", () => {
	expect(dockerignore).not.toMatch(/^libs\/?$/m);
	expect(dockerignore).not.toMatch(/^integrations\/?$/m);
	expect(dockerignore).not.toMatch(/^platform\/?$/m);
	expect(dockerignore).not.toMatch(/^surfaces\/?$/m);
	expect(dockerignore).not.toMatch(/^web\/?$/m);
});
