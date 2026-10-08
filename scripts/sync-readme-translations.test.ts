import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	LOCALES,
	SWITCHER,
	assembleTranslation,
	githubSlug,
	splitTranslation,
	stripFence,
	validateTranslation,
} from "./sync-readme-translations";

const ENGLISH = [
	"# Signet",
	"",
	"[Quick start](#quick-start) · [Docs](https://docs.signetai.sh/)",
	"",
	SWITCHER,
	"",
	'<img src="public/banner.png" alt="Banner">',
	"",
	"## Quick start",
	"",
	"```bash",
	"signet setup   # prepare a workspace",
	"```",
	"",
].join("\n");

const JAPANESE = [
	"# Signet",
	"",
	"[クイックスタート](#クイックスタート) · [ドキュメント](https://docs.signetai.sh/)",
	"",
	SWITCHER,
	"",
	'<img src="public/banner.png" alt="バナー">',
	"",
	"## クイックスタート",
	"",
	"```bash",
	"signet setup   # prepare a workspace",
	"```",
	"",
].join("\n");

const japanese = LOCALES.find((locale) => locale.code === "ja");
if (!japanese) throw new Error("ja locale missing");

describe("validateTranslation", () => {
	test("accepts a faithful translation with rewritten anchors", () => {
		expect(validateTranslation(ENGLISH, JAPANESE)).toEqual([]);
	});

	test("accepts the real README against itself", () => {
		const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
		expect(validateTranslation(readme, readme)).toEqual([]);
	});

	test("rejects a translated code block", () => {
		const broken = JAPANESE.replace("# prepare a workspace", "# ワークスペースを準備");
		expect(validateTranslation(ENGLISH, broken)).toContain("Code block 1 must be copied unchanged.");
	});

	test("rejects a changed link target", () => {
		const broken = JAPANESE.replace("https://docs.signetai.sh/", "https://docs.signetai.sh/ja/");
		expect(validateTranslation(ENGLISH, broken)).toContain(
			"Link or image target is missing or changed: https://docs.signetai.sh/",
		);
	});

	test("rejects an in-page link left pointing at the English heading", () => {
		const broken = JAPANESE.replace("(#クイックスタート)", "(#quick-start)");
		expect(validateTranslation(ENGLISH, broken).some((error) => error.startsWith("In-page link #quick-start"))).toBe(
			true,
		);
	});

	test("rejects a missing or altered language switcher", () => {
		const broken = JAPANESE.replace("[English](README.md)", "[英語](README.md)");
		expect(validateTranslation(ENGLISH, broken)[0]).toStartWith("The language switcher line must appear exactly once");
	});

	test("rejects a dropped heading", () => {
		const broken = JAPANESE.replace("## クイックスタート", "クイックスタート");
		expect(validateTranslation(ENGLISH, broken)).toContain(
			"Headings must keep the same count, order, and levels as the English source.",
		);
	});
});

describe("translation files", () => {
	test("round-trips the marker and reader note", () => {
		const blob = "a".repeat(40);
		const file = assembleTranslation(JAPANESE, japanese, blob);
		expect(file).toContain(japanese.note);
		expect(splitTranslation(file, japanese)).toEqual({ blob, body: JAPANESE });
	});

	test("strips a surrounding markdown fence from model output", () => {
		expect(stripFence("```markdown\n# Signet\n```\n")).toBe("# Signet\n");
		expect(stripFence("# Signet")).toBe("# Signet\n");
	});

	test("builds GitHub anchors from translated headings", () => {
		expect(githubSlug("## Inspecting and trusting memory")).toBe("inspecting-and-trusting-memory");
		expect(githubSlug("## Dashboard und Desktop-App")).toBe("dashboard-und-desktop-app");
		expect(githubSlug("## 快速开始")).toBe("快速开始");
	});

	test("README.md carries the language switcher", () => {
		const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
		expect(readme.split("\n")).toContain(SWITCHER);
	});
});
