import { describe, expect, test } from "bun:test";
import { generateMemory, parseMemory } from "../memory";

describe("parseMemory", () => {
	test("parses the generated template as empty structured fields", () => {
		const markdown = generateMemory();

		expect(parseMemory(markdown)).toEqual({
			userProfile: "",
			keyFacts: "",
			ongoingContext: "",
			manualNotes: "",
			raw: markdown,
		});
	});

	test("extracts populated sections and manual notes without cross-contamination", () => {
		const markdown = `# Memory

## User Profile

Prefers terse updates.

## Key Facts

- Uses Signet locally.

## Ongoing Context

Reviewing parser behavior.

<!-- MANUAL:START -->
Keep this hand-written note.
<!-- MANUAL:END -->
`;

		expect(parseMemory(markdown)).toEqual({
			userProfile: "Prefers terse updates.",
			keyFacts: "- Uses Signet locally.",
			ongoingContext: "Reviewing parser behavior.",
			manualNotes: "Keep this hand-written note.",
			raw: markdown,
		});
	});

	test("ignores markdown headings inside manual notes when parsing structured sections", () => {
		const markdown = `# Memory

## User Profile

Real profile.

## Key Facts

Real fact.

## Ongoing Context

Real context.

<!-- MANUAL:START -->
## User Profile

Manual note profile heading.

## Key Facts

Manual note fact heading.
<!-- MANUAL:END -->
`;

		expect(parseMemory(markdown)).toEqual({
			userProfile: "Real profile.",
			keyFacts: "Real fact.",
			ongoingContext: "Real context.",
			manualNotes: "## User Profile\n\nManual note profile heading.\n\n## Key Facts\n\nManual note fact heading.",
			raw: markdown,
		});
	});

	test("preserves raw markdown for round trips", () => {
		const markdown = "# Memory\n\n## Key Facts\n\n- one\n";

		expect(parseMemory(markdown).raw).toBe(markdown);
	});
});
