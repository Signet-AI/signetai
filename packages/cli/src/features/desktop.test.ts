import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDesktopFromSource,
	installDesktopFromSource,
	installLinuxDesktopApp,
	resolveDesktopSourceCheckout,
} from "./desktop.js";

function makeCheckout(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-desktop-test-"));
	mkdirSync(join(root, "packages", "desktop", "icons"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "signet" }));
	writeFileSync(join(root, "packages", "desktop", "package.json"), JSON.stringify({ name: "@signet/desktop" }));
	writeFileSync(join(root, "packages", "desktop", "icons", "icon.png"), "icon");
	return root;
}

describe("desktop source checkout resolution", () => {
	test("finds an ancestor checkout from cwd", () => {
		const root = makeCheckout();
		try {
			const cwd = join(root, "packages", "desktop");
			expect(resolveDesktopSourceCheckout(undefined, { cwd, home: join(root, "home"), env: {} })).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects explicit non-checkout paths", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-desktop-missing-"));
		try {
			expect(() => resolveDesktopSourceCheckout(root, { env: {} })).toThrow("Not a Signet source checkout");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("desktop source build", () => {
	test("runs dependency install before desktop build", () => {
		const root = makeCheckout();
		const calls: string[] = [];
		try {
			const result = buildDesktopFromSource(
				{ repo: root },
				{
					runner: (cmd, args, opts) => {
						calls.push(`${cmd} ${args.join(" ")} @ ${opts.cwd}`);
						return { status: 0 };
					},
				},
			);

			expect(result.releaseDir).toBe(join(root, "packages", "desktop", "release"));
			expect(calls).toEqual([`bun install @ ${root}`, `bun run build:desktop @ ${root}`]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("linux desktop install", () => {
	test("installs the newest AppImage as a user launcher", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "packages", "desktop", "release");
			mkdirSync(join(release, "nested"), { recursive: true });
			const oldArtifact = join(release, "Signet-old.AppImage");
			const newArtifact = join(release, "nested", "Signet-new.AppImage");
			writeFileSync(oldArtifact, "old");
			writeFileSync(newArtifact, "new");
			utimesSync(oldArtifact, new Date(1_000), new Date(1_000));
			utimesSync(newArtifact, new Date(2_000), new Date(2_000));

			const result = installLinuxDesktopApp(root, home);

			expect(readFileSync(result.appImage, "utf8")).toBe("new");
			expect(readlinkSync(result.binary)).toBe(result.appImage);
			expect(readFileSync(result.desktopEntry, "utf8")).toContain("Name=Signet");
			expect(readFileSync(result.desktopEntry, "utf8")).toContain(`Exec=\"${result.binary}\" %U`);
			expect(existsSync(result.icon)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("skip-build install does not run build commands", () => {
		const root = makeCheckout();
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-home-"));
		try {
			const release = join(root, "packages", "desktop", "release");
			mkdirSync(release, { recursive: true });
			writeFileSync(join(release, "Signet.AppImage"), "app");

			const result = installDesktopFromSource(
				{ repo: root, skipBuild: true },
				{
					home,
					platform: "linux",
					runner: () => {
						throw new Error("runner should not be called");
					},
				},
			);

			expect(existsSync(result.appImage)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
