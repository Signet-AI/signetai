import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("native bundle release regressions", () => {
	test("publishes bootstrap helper scripts to the latest bundle release", () => {
		const workflow = readFileSync(join(root, ".github", "workflows", "bundle.yml"), "utf-8");

		expect(workflow).toContain("Upload manifests and latest helpers");
		expect(workflow).toContain("Missing staged latest helper asset");
		expect(workflow).toContain(
			'for helper_asset in "/tmp/release-staging/$script" "/tmp/release-staging/$script.sha256"; do',
		);
		expect(workflow).toContain('gh release upload "$TAG" "$helper_asset" --repo "$REPO" --clobber');
	});

	test("defers helper wrapper path resolution until wrapper execution", () => {
		const installer = readFileSync(join(root, "deploy", "bundle", "install.sh"), "utf-8");
		const updater = readFileSync(join(root, "deploy", "bundle", "update.sh"), "utf-8");

		for (const script of [installer, updater]) {
			expect(script).toContain("cat > \"${bindir}/signet-uninstall\" << 'WRAPPER'");
			expect(script).toContain("cat > \"${bindir}/signet-update\" << 'WRAPPER'");
			expect(script).toContain('SIGNET_INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"');
			expect(script).toContain('exec "$SIGNET_INSTALL_DIR/bin/_uninstall.sh" "$@"');
			expect(script).toContain('exec "$SIGNET_INSTALL_DIR/bin/_update.sh" "$@"');
			expect(script).not.toContain('cat > "${bindir}/signet-uninstall" << WRAPPER');
			expect(script).not.toContain('cat > "${bindir}/signet-update" << WRAPPER');
			expect(script).not.toContain('exec "\\$SIGNET_INSTALL_DIR/bin/_uninstall.sh" "\\$@"');
			expect(script).not.toContain('exec "\\$SIGNET_INSTALL_DIR/bin/_update.sh" "\\$@"');
		}
	});
});
