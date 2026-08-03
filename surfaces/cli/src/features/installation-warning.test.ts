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
