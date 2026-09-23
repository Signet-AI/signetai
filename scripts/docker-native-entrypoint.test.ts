import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entrypoint = readFileSync(join(root, "deploy/docker/entrypoint.sh"), "utf8");
const dockerfile = readFileSync(join(root, "deploy/docker/Dockerfile"), "utf8");

describe("native Docker runtime entrypoint", () => {
	it("dispatches through the compiled CLI to the packaged Rust daemon", () => {
		expect(entrypoint).toContain("exec /app/bin/signet\n");
		expect(entrypoint).not.toContain("exec /app/bin/signet-daemon");
		expect(dockerfile).toContain("SIGNET_DAEMON_ENTRYPOINT=1");
		expect(dockerfile).toContain("SIGNET_DAEMON_PATH=/app/bin/signet-daemon");
		expect(dockerfile).toContain(
			"COPY --from=daemon-build /app/platform/rust-daemon/target/release/signet-daemon ./bin/signet-daemon",
		);
	});
});
