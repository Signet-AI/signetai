import { describe, expect, it } from "bun:test";
import type { Skill } from "@/lib/api";
import { filterSkills, stripFrontmatter } from "./skills";

const skill = (name: string, description: string): Skill => ({ name, description, userInvocable: false });

describe("skills view", () => {
	it("ranks name matches ahead of description matches", () => {
		const skills = [skill("daily-brief", "Obsidian morning briefs"), skill("obsidian-cli", "Vault commands")];
		expect(filterSkills(skills, "obsidian").map((item) => item.name)).toEqual(["obsidian-cli", "daily-brief"]);
		expect(filterSkills(skills, "  ")).toBe(skills);
	});

	it("renders SKILL.md without its frontmatter", () => {
		expect(stripFrontmatter("---\nname: x\ndescription: |\n  y\n---\n\n# Title\nBody")).toBe("# Title\nBody");
		expect(stripFrontmatter("# No frontmatter")).toBe("# No frontmatter");
	});
});
