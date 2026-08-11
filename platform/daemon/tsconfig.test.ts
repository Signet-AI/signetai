import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type TypeScriptConfig = {
	compilerOptions?: {
		noUncheckedIndexedAccess?: boolean;
	};
};

const rootConfig = JSON.parse(readFileSync(join(import.meta.dir, "../../tsconfig.json"), "utf8")) as TypeScriptConfig;
const daemonConfig = JSON.parse(readFileSync(join(import.meta.dir, "tsconfig.json"), "utf8")) as TypeScriptConfig;
const daemonTypecheckWorkflow = readFileSync(
	join(import.meta.dir, "../../.github/workflows/daemon-typecheck.yml"),
	"utf8",
);

test("keeps daemon production typecheck scoped without weakening the shared strictness", () => {
	expect(rootConfig.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
	expect(daemonConfig.compilerOptions?.noUncheckedIndexedAccess).toBe(false);
	expect(daemonTypecheckWorkflow).toContain("npx tsc --noEmit");
	expect(daemonTypecheckWorkflow).not.toContain("continue-on-error");
});
