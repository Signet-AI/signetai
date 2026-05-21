import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

describe("search visibility regression guard", () => {
	it("keeps the Hermes Agent and OpenClaw memory discovery path explicit", () => {
		const guide = read("docs/ai-memory-hermes-openclaw.md");
		const post = read("web/marketing/src/content/blog/self-hosted-ai-memory-hermes-openclaw.mdx");
		const pkg = JSON.parse(read("dist/signetai/package.json")) as {
			readonly keywords?: readonly string[];
		};

		for (const content of [guide, post]) {
			expect(content).toContain("self-hosted AI memory");
			expect(content).toContain("self hosted AI memory");
			expect(content).toContain("Hermes Agent");
			expect(content).toContain("OpenClaw");
		}

		expect(pkg.keywords).toContain("hermes-agent");
		expect(pkg.keywords).toContain("openclaw");
		expect(pkg.keywords).toContain("ai-memory");
		expect(pkg.keywords).toContain("memory-provider");
	});
});
