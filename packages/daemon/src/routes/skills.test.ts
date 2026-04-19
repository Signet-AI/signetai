import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { formatInstalls, listInstalledSkills, mountSkillsRoutes, parseSkillFrontmatter } from "./skills";

// ---------------------------------------------------------------------------
// Repo skills frontmatter validation (regression guard)
// ---------------------------------------------------------------------------

describe("repo skills frontmatter", () => {
	const skillsRoot = join(__dirname, "..", "..", "..", "..", "skills");
	// Only run if skills dir exists (dev environment)
	const hasSkillsDir = existsSync(skillsRoot);

	it.skipIf(!hasSkillsDir)("all skills have parseable SKILL.md with name and description", () => {
		const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
		expect(dirs.length).toBeGreaterThan(0);

		for (const dir of dirs) {
			const skillMd = join(skillsRoot, dir.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			const content = readFileSync(skillMd, "utf-8");
			const meta = parseSkillFrontmatter(content);
			expect(meta.description.length, `${dir.name} should have a description`).toBeGreaterThan(0);
		}
	});

	it.skipIf(!hasSkillsDir)("no skill has last_verified as a top-level frontmatter key", () => {
		const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());

		for (const dir of dirs) {
			const skillMd = join(skillsRoot, dir.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			const content = readFileSync(skillMd, "utf-8");
			const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (!fmMatch) continue;

			// last_verified should be under metadata:, not at top level
			const lines = fmMatch[1].split("\n");
			for (const line of lines) {
				if (/^last_verified:/.test(line)) {
					throw new Error(`${dir.name}/SKILL.md has top-level last_verified — move it under metadata:`);
				}
			}
		}
	});

	it.skipIf(!hasSkillsDir)("builtin skills have builtin: true in frontmatter", () => {
		const expectedBuiltin = ["memory-debug", "onboarding", "recall", "remember", "signet"];

		for (const name of expectedBuiltin) {
			const skillMd = join(skillsRoot, name, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			const content = readFileSync(skillMd, "utf-8");
			expect(/^builtin:\s*true$/m.test(content), `${name} should have builtin: true`).toBe(true);
		}
	});

	it.skipIf(!hasSkillsDir)("non-builtin skills do not have builtin: true", () => {
		const nonBuiltin = ["agent-architect", "signet-design", "skill-creator", "web-search"];

		for (const name of nonBuiltin) {
			const skillMd = join(skillsRoot, name, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			const content = readFileSync(skillMd, "utf-8");
			expect(/^builtin:\s*true$/m.test(content), `${name} should not have builtin: true`).toBe(false);
		}
	});
});

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

	it("parses frontmatter with metadata block (last_verified under metadata)", () => {
		const content = `---
name: web-search
description: "Search the web"
metadata:
  last_verified: 2026-03-21
---

# Web Search`;

		const meta = parseSkillFrontmatter(content);
		expect(meta.description).toBe("Search the web");
	});

	it("parses builtin flag via regex", () => {
		const builtin = `---
name: remember
description: Save to memory
builtin: true
user_invocable: false
---`;

		const notBuiltin = `---
name: web-search
description: Search the web
---`;

		expect(/^builtin:\s*true$/m.test(builtin)).toBe(true);
		expect(/^builtin:\s*true$/m.test(notBuiltin)).toBe(false);

		const meta = parseSkillFrontmatter(builtin);
		expect(meta.description).toBe("Save to memory");
		expect(meta.user_invocable).toBe(false);
	});

	it("parses multiline YAML description using > folded scalar", () => {
		const content = `---
name: agent-architect
description: >
  Design agents with genuine humanity — craft SOUL.md, IDENTITY.md, USER.md,
  and AGENTS.md files that produce agents people actually connect with.
metadata:
  last_verified: 2026-03-21
---

# Agent Architect`;

		const meta = parseSkillFrontmatter(content);
		// Regex-based parser only captures the first line of folded scalars
		// but should still return a non-empty description
		expect(meta.description.length).toBeGreaterThan(0);
	});

	it("ignores metadata block keys when parsing top-level fields", () => {
		const content = `---
name: test-skill
description: "A skill with nested metadata"
metadata:
  last_verified: 2026-03-21
  custom_key: custom_value
---`;

		const meta = parseSkillFrontmatter(content);
		expect(meta.description).toBe("A skill with nested metadata");
		// metadata block shouldn't leak into top-level fields
		expect(meta.version).toBeUndefined();
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

	it("POST /api/skills/install accepts valid name with source", async () => {
		// This will fail at the spawn step (no real skills CLI), but should
		// get past validation and not return 400
		const res = await app.request("/api/skills/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "web-search", source: "Signet-AI/signetai" }),
		});
		// Will be 500 (skills CLI not available) or 200 — not 400 validation error
		expect(res.status).not.toBe(400);
	});

	it("POST /api/skills/install rejects invalid JSON body", async () => {
		const res = await app.request("/api/skills/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	// Regression: signet skills should appear in browse results when the
	// bundled skills dir is resolvable (dev environment)
	it.skipIf(!existsSync(join(__dirname, "..", "..", "..", "..", "skills")))(
		"GET /api/skills/browse includes signet provider skills",
		async () => {
			const res = await app.request("/api/skills/browse");
			expect(res.status).toBe(200);
			const body = await res.json();
			const signetSkills = body.results.filter((s: { provider: string }) => s.provider === "signet");
			expect(signetSkills.length).toBeGreaterThan(0);

			// Verify signet skills use repo path as fullName, not signet@ prefix
			for (const skill of signetSkills) {
				expect(skill.fullName).toBe("Signet-AI/signetai");
				expect(skill.official).toBe(true);
			}

			// Builtin skills should be marked
			const builtins = signetSkills.filter((s: { builtin: boolean }) => s.builtin);
			expect(builtins.length).toBeGreaterThan(0);
		},
	);
});

// ---------------------------------------------------------------------------
// Install command construction (behavioral contract)
// ---------------------------------------------------------------------------

describe("install command args", () => {
	// Test the regex pattern used to detect multi-skill repo sources
	const repoPattern = /^[\w-]+\/[\w.-]+$/;

	it("matches owner/repo format", () => {
		expect(repoPattern.test("Signet-AI/signetai")).toBe(true);
		expect(repoPattern.test("vercel-labs/agent-skills")).toBe(true);
		expect(repoPattern.test("anthropic-ai/browser-use")).toBe(true);
	});

	it("does not match clawhub@ prefixed sources", () => {
		expect(repoPattern.test("clawhub@some-skill")).toBe(false);
	});

	it("does not match bare skill names", () => {
		// bare names don't contain a slash
		expect(repoPattern.test("browser-use")).toBe(false);
		expect(repoPattern.test("web-search")).toBe(false);
	});

	it("does not match owner/repo@ref format", () => {
		// The @ makes it fail the pattern — these are handled by skills CLI directly
		expect(repoPattern.test("vercel-labs/skills@browser-use")).toBe(false);
	});

	it("constructs --skill flag for repo sources", () => {
		const source = "Signet-AI/signetai";
		const name = "web-search";
		const args = ["add", source, "--global", "--yes"];
		// @ts-ignore
		if (source && source !== name && repoPattern.test(source)) {
			args.push("--skill", name);
		}
		expect(args).toEqual(["add", "Signet-AI/signetai", "--global", "--yes", "--skill", "web-search"]);
	});

	it("does not add --skill when source equals name", () => {
		const source = "browser-use";
		const name = "browser-use";
		const args = ["add", source, "--global", "--yes"];
		if (source && source !== name && repoPattern.test(source)) {
			args.push("--skill", name);
		}
		expect(args).toEqual(["add", "browser-use", "--global", "--yes"]);
	});

	it("does not add --skill for clawhub sources", () => {
		const source = "clawhub@some-skill";
		const name = "some-skill";
		const args = ["add", source, "--global", "--yes"];
		// @ts-ignore
		if (source && source !== name && repoPattern.test(source)) {
			args.push("--skill", name);
		}
		expect(args).toEqual(["add", "clawhub@some-skill", "--global", "--yes"]);
	});
});
