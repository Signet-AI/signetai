import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function workflow(): Promise<string> {
	return Bun.file(join(ROOT, ".github/workflows/pr-baseline.yml")).text();
}

test("PR baseline is always on and uses the pinned hermetic install", async () => {
	const source = await workflow();
	expect(source).toContain("pull_request:");
	expect(source).toContain("push:");
	expect(source).toContain("branches: [main]");
	expect(source).not.toContain("paths:");
	expect(source).toContain("permissions:\n  contents: read");
	expect(source).toContain("fetch-depth: 0");
	expect(source).toContain("bun-version-file: package.json");
	expect(source).toContain("bun install --frozen-lockfile");
	expect(source).toContain("HEAD_SHA: $" + "{{ github.event.pull_request.head.sha || github.sha }}");
	expect(source).toContain('ELECTRON_SKIP_BINARY_DOWNLOAD: "1"');
	expect(source).toContain('PUPPETEER_SKIP_DOWNLOAD: "1"');
});

test("PR baseline runs architecture audits, the complete workspace suite, and typecheck", async () => {
	const source = await workflow();
	for (const command of [
		"bun run comments:check",
		'bun run check:production-comments --base "$BASE_SHA" --head "$HEAD_SHA"',
		"bun run audit:database-ownership",
		"bun run audit:agent-identity",
		"bun test scripts/strip-comments.test.ts scripts/check-production-comments.test.ts scripts/audit-database-ownership.test.ts scripts/audit-agent-identity.test.ts scripts/pr-baseline-workflow.test.ts",
		"bun run typecheck",
		"run: bun run test",
	]) {
		expect(source).toContain(command);
	}
	expect(source.indexOf("run: bun run test")).toBeLessThan(source.indexOf("bun run typecheck"));
	expect(source).not.toContain("run: bun run build\n");
	expect(source).not.toContain("  typecheck:\n");
});

test("PR baseline leaves specialized acceptance and release work to owning workflows", async () => {
	const source = await workflow();
	for (const excluded of [
		"desktop-build",
		"docker-smoke",
		"embedding-health-isolation",
		"native-first-use",
		"phase-d-acceptance",
		"release.yml",
		"references/",
	]) {
		expect(source).not.toContain(excluded);
	}
});
