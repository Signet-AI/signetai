import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entrypoint = readFileSync(join(root, "deploy/docker/entrypoint.sh"), "utf8");
const dockerfile = readFileSync(join(root, "deploy/docker/Dockerfile"), "utf8");

describe("native Docker runtime entrypoint", () => {
	it("execs the packaged Rust daemon and packages it", () => {
		expect(entrypoint).toContain("exec /app/bin/signet-daemon");
		expect(entrypoint).not.toContain("exec /app/bin/signet\n");
		expect(dockerfile).toContain(
			"COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-daemon ./bin/signet-daemon",
		);
	});
});
