import { describe, expect, it } from "bun:test";
import { concurrentInstallationWarningLines } from "./installation-warning";

describe("concurrentInstallationWarningLines", () => {
	it("asks the user to remove an inactive npm wrapper after verifying native", () => {
		const lines = concurrentInstallationWarningLines(
			{
				target: {
					kind: "native",
					executablePath: "/home/test/.local/bin/signet",
				},
				targetPathResolvable: true,
				installations: [],
				inactive: [
					{
						method: "npm",
						executablePath: "/home/test/.npm-global/bin/signet",
						packagePath: "/home/test/.npm-global/lib/node_modules/signetai",
						active: false,
						removalCommand: "rm -f -- '/home/test/.npm-global/bin/signet'",
					},
				],
			},
			"/home/test",
		);

		expect(lines.join("\n")).toContain("Active:   ~/.local/bin/signet (native)");
		expect(lines.join("\n")).toContain("Inactive: ~/.npm-global/bin/signet (npm)");
		expect(lines.join("\n")).toContain("rm -f -- '/home/test/.npm-global/bin/signet'");
		expect(lines.join("\n")).toContain("keeps signet-mcp available");
	});

	it("does not recommend removal when native is not resolvable from PATH", () => {
		const lines = concurrentInstallationWarningLines(
			{
				target: {
					kind: "native",
					executablePath: "/home/test/node_modules/signetai/native/signet",
				},
				targetPathResolvable: false,
				installations: [],
				inactive: [
					{
						method: "bun",
						executablePath: "/home/test/.bun/bin/signet",
						active: false,
						removalCommand: "rm -f -- '/home/test/.bun/bin/signet'",
					},
				],
			},
			"/home/test",
		);

		expect(lines.join("\n")).toContain("not resolvable as `signet` on PATH");
		expect(lines.join("\n")).not.toContain("rm -f --");
	});

	it("stays silent for a package-manager-only installation", () => {
		expect(
			concurrentInstallationWarningLines({
				target: {
					kind: "package-manager",
					family: "npm",
					executablePath: "/npm/signetai/native/signet",
				},
				installations: [],
				inactive: [],
			}),
		).toEqual([]);
	});
});
