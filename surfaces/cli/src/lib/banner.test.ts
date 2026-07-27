import { describe, expect, it } from "bun:test";
import { signetBanner } from "./banner.js";

const DOT = "●";
const CRESCENTS = ["◐", "◑"];

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ANSI escape introducer
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("signetBanner", () => {
	it("renders the dot-grid mark at 9x7 with 28 dots", () => {
		const plain = stripAnsi(signetBanner({ version: "1.2.3" }));
		const rows = plain
			.trim()
			.split("\n")
			.map((line) => line.trimEnd());
		expect(rows).toHaveLength(7);

		const markOnly = rows.map((line) => line.slice(0, 20));
		const dots = markOnly
			.join("")
			.split("")
			.filter((ch) => ch === DOT);
		const crescents = markOnly
			.join("")
			.split("")
			.filter((ch) => CRESCENTS.includes(ch));
		expect(dots).toHaveLength(26);
		expect(crescents).toHaveLength(2);
	});

	it("includes name, tagline, and version on aligned side rows", () => {
		const plain = stripAnsi(signetBanner({ version: "1.2.3" }));
		expect(plain).toContain("Signet CLI");
		expect(plain).toContain("Own your agent. Bring it anywhere.");
		expect(plain).toContain("v1.2.3");

		const rows = plain.trim().split("\n");
		const sideStarts = rows
			.filter((line) => /Signet CLI|Own your agent|v1\.2\.3/.test(line))
			.map((line) => line.search(/Signet CLI|Own your agent|v1\.2\.3/));
		expect(sideStarts).toHaveLength(3);
		expect(new Set(sideStarts).size).toBe(1);
	});
});
