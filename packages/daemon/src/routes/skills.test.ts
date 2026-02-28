import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { formatInstalls, listInstalledSkills, mountSkillsRoutes, parseSkillFrontmatter } from "./skills";

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter", () => {
	it("parses valid frontmatter with all fields", () => {
		const content = `---
description: A test skill
version: 1.0.0
author: test-author
license: MIT
user_invocable: true
arg_hint: <query>
---

# Skill content here`;

		const meta = parseSkillFrontmatter(content);
		expect(meta.description).toBe("A test skill");
		expect(meta.version).toBe("1.0.0");
		expect(meta.author).toBe("test-author");
		expect(meta.license).toBe("MIT");
		expect(meta.user_invocable).toBe(true);
		expect(meta.arg_hint).toBe("<query>");
	});

	it("returns empty description when no frontmatter present", () => {
		const content = "# Just a markdown file\n\nNo frontmatter here.";
		const meta = parseSkillFrontmatter(content);
		expect(meta.description).toBe("");
		expect(meta.version).toBeUndefined();
		expect(meta.author).toBeUndefined();
	});

	it("handles partial frontmatter fields", () => {
		const content = `---
description: Only description
---

Body text`;

		const meta = parseSkillFrontmatter(content);
		expect(meta.description).toBe("Only description");
		expect(meta.version).toBeUndefined();
		expect(meta.author).toBeUndefined();
		expect(meta.license).toBeUndefined();
		expect(meta.user_invocable).toBe(false);
		expect(meta.arg_hint).toBeUndefined();
	});

	it("strips surrounding quotes from values", () => {
		const content = `---
description: "quoted description"
author: 'single-quoted'
---`;

		const meta = parseSkillFrontmatter(content);
		expect(meta.description).toBe("quoted description");
		expect(meta.author).toBe("single-quoted");
	});

	it("parses optional verified and permissions metadata", () => {
		const content = `---
description: metadata skill
verified: true
permissions: [network, filesystem]
---`;

		const meta = parseSkillFrontmatter(content);
		expect(meta.verified).toBe(true);
		expect(meta.permissions).toEqual(["network", "filesystem"]);
	});
});

// ---------------------------------------------------------------------------
// formatInstalls
// ---------------------------------------------------------------------------

describe("formatInstalls", () => {
	it("returns raw number for values under 1000", () => {
		expect(formatInstalls(0)).toBe("0");
		expect(formatInstalls(1)).toBe("1");
		expect(formatInstalls(999)).toBe("999");
	});

	it("formats thousands with K suffix", () => {
		expect(formatInstalls(1000)).toBe("1.0K");
		expect(formatInstalls(1500)).toBe("1.5K");
		expect(formatInstalls(999999)).toBe("1000.0K");
	});

	it("formats millions with M suffix", () => {
		expect(formatInstalls(1000000)).toBe("1.0M");
		expect(formatInstalls(1500000)).toBe("1.5M");
	});
});

// ---------------------------------------------------------------------------
// listInstalledSkills (with temp directory)
// ---------------------------------------------------------------------------

describe("listInstalledSkills", () => {
	const tmpAgentsDir = join(tmpdir(), `signet-test-agents-${process.pid}`);
	const tmpSkillsDir = join(tmpAgentsDir, "skills");
	let origSignetPath: string | undefined;

	beforeEach(() => {
		origSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = tmpAgentsDir;
		mkdirSync(tmpSkillsDir, { recursive: true });
	});

	afterEach(() => {
		process.env.SIGNET_PATH = origSignetPath;
		if (existsSync(tmpAgentsDir)) {
			rmSync(tmpAgentsDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when skills dir has no subdirs", () => {
		const result = listInstalledSkills();
		expect(result).toEqual([]);
	});

	it("returns empty array when skills dir does not exist", () => {
		rmSync(tmpSkillsDir, { recursive: true, force: true });
		const result = listInstalledSkills();
		expect(result).toEqual([]);
	});

	it("skips directories without SKILL.md", () => {
		mkdirSync(join(tmpSkillsDir, "no-skillmd"), { recursive: true });
		writeFileSync(join(tmpSkillsDir, "no-skillmd", "README.md"), "# Hello");
		const result = listInstalledSkills();
		expect(result).toEqual([]);
	});

	it("returns skills with parsed metadata", () => {
		const skillDir = join(tmpSkillsDir, "my-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
description: My cool skill
version: 2.0.0
user_invocable: true
---

# My Skill`,
		);

		const result = listInstalledSkills();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("my-skill");
		expect(result[0].description).toBe("My cool skill");
		expect(result[0].version).toBe("2.0.0");
		expect(result[0].user_invocable).toBe(true);
		expect(result[0].path).toBe(skillDir);
	});

	it("handles mix of valid and invalid skill dirs", () => {
		// Valid skill
		const validDir = join(tmpSkillsDir, "valid-skill");
		mkdirSync(validDir, { recursive: true });
		writeFileSync(
			join(validDir, "SKILL.md"),
			`---
description: Valid
---`,
		);

		// Dir without SKILL.md
		mkdirSync(join(tmpSkillsDir, "empty-dir"), { recursive: true });

		const result = listInstalledSkills();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("valid-skill");
	});
});

// ---------------------------------------------------------------------------
// Route integration tests (Hono test client, backed by temp fixture)
// ---------------------------------------------------------------------------

describe("skills routes", () => {
	const tmpAgentsDir = join(tmpdir(), `signet-route-test-${process.pid}`);
	const skillsDir = join(tmpAgentsDir, "skills");
	let origSignetPath: string | undefined;
	let app: Hono;

	beforeEach(() => {
		origSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = tmpAgentsDir;

		mkdirSync(skillsDir, { recursive: true });

		// Create a test skill in the fixture
		const testSkillDir = join(skillsDir, "test-skill");
		mkdirSync(testSkillDir, { recursive: true });
		writeFileSync(
			join(testSkillDir, "SKILL.md"),
			`---
description: A test skill
version: 1.0.0
user_invocable: true
---

# Test Skill

This is a test skill.`,
		);

		app = new Hono();
		mountSkillsRoutes(app);
	});

	afterEach(() => {
		process.env.SIGNET_PATH = origSignetPath;
		if (existsSync(tmpAgentsDir)) {
			rmSync(tmpAgentsDir, { recursive: true, force: true });
		}
	});

	it("GET /api/skills lists installed skills from fixture", async () => {
		const res = await app.request("/api/skills");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(1);
		expect(body.skills).toHaveLength(1);
		expect(body.skills[0].name).toBe("test-skill");
		expect(body.skills[0].description).toBe("A test skill");
	});

	it("GET /api/skills returns empty when no skills installed", async () => {
		rmSync(skillsDir, { recursive: true, force: true });
		const res = await app.request("/api/skills");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.count).toBe(0);
		expect(body.skills).toEqual([]);
	});

	it("GET /api/skills/:name returns skill content from fixture", async () => {
		const res = await app.request("/api/skills/test-skill");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe("test-skill");
		expect(body.description).toBe("A test skill");
		expect(body.version).toBe("1.0.0");
		expect(body.content).toContain("# Test Skill");
	});

	it("GET /api/skills/:name returns 400 for path traversal", async () => {
		const res = await app.request("/api/skills/..%2F..%2Fetc");
		expect(res.status).toBe(400);
	});

	it("GET /api/skills/:name returns 404 for missing skill", async () => {
		const res = await app.request("/api/skills/nonexistent-skill-xyz");
		expect(res.status).toBe(404);
	});

	it("DELETE /api/skills/:name removes skill from fixture", async () => {
		const res = await app.request("/api/skills/test-skill", {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.name).toBe("test-skill");

		// Verify it's actually gone
		expect(existsSync(join(skillsDir, "test-skill"))).toBe(false);
	});

	it("DELETE /api/skills/:name rejects path traversal", async () => {
		const res = await app.request("/api/skills/..%2Ffoo", {
			method: "DELETE",
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid skill name");
	});

	it("DELETE /api/skills/:name returns 404 for missing skill", async () => {
		const res = await app.request("/api/skills/does-not-exist", {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
	});

	it("POST /api/skills/install rejects missing name", async () => {
		const res = await app.request("/api/skills/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("name is required");
	});

	it("POST /api/skills/install rejects invalid name characters", async () => {
		const res = await app.request("/api/skills/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "skill; rm -rf /" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid skill name");
	});

	it("GET /api/skills/search returns 400 without query", async () => {
		const res = await app.request("/api/skills/search");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Query parameter q is required");
	});
});
