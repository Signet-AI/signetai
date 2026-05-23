export interface ParsedMemory {
	/** Content under the "## User Profile" section. */
	userProfile: string;
	/** Content under the "## Key Facts" section. */
	keyFacts: string;
	/** Content under the "## Ongoing Context" section. */
	ongoingContext: string;
	/** Content between MANUAL:START and MANUAL:END markers. */
	manualNotes: string;
	/** The full raw markdown input, preserved for round-tripping. */
	raw: string;
}

const TEMPLATE_PLACEHOLDERS: Readonly<Record<string, string>> = {
	"User Profile": "*No user profile configured yet.*",
	"Key Facts": "*No facts stored yet.*",
	"Ongoing Context": "*No ongoing context.*",
};
const MANUAL_NOTES_PLACEHOLDER = "<!-- Add your own notes here - they will be preserved -->";

function normalizeSection(sectionName: string, content: string): string {
	const trimmed = content.trim();
	return trimmed === TEMPLATE_PLACEHOLDERS[sectionName] ? "" : trimmed;
}

function normalizeManualNotes(content: string): string {
	const trimmed = content.trim();
	return trimmed === MANUAL_NOTES_PLACEHOLDER ? "" : trimmed;
}

/**
 * Parse a Signet memory markdown file into structured sections.
 *
 * Extracts content from well-known `## ` headings and the
 * `<!-- MANUAL:START -->` / `<!-- MANUAL:END -->` block. Any content
 * outside recognized sections is ignored — the `raw` field always
 * contains the original markdown for lossless round-tripping.
 */
export function parseMemory(markdown: string): ParsedMemory {
	const sections: Record<string, string> = {};
	let currentSection: string | null = null;
	let inManualBlock = false;
	const sectionLines: string[] = [];

	const flushSection = (): void => {
		if (currentSection === null) {
			return;
		}
		sections[currentSection] = normalizeSection(currentSection, sectionLines.join("\n"));
	};

	const lines = markdown.split("\n");
	for (const line of lines) {
		if (/^<!--\s*MANUAL:START\s*-->$/.test(line)) {
			flushSection();
			inManualBlock = true;
			currentSection = null;
			sectionLines.length = 0;
			continue;
		}
		if (/^<!--\s*MANUAL:END\s*-->$/.test(line)) {
			inManualBlock = false;
			continue;
		}
		if (inManualBlock) {
			continue;
		}

		const headingMatch = line.match(/^##\s+(.+)/);
		if (headingMatch) {
			flushSection();
			currentSection = headingMatch[1].trim();
			sectionLines.length = 0;
		} else if (currentSection !== null) {
			sectionLines.push(line);
		}
	}
	flushSection();

	const manualMatch = markdown.match(/<!--\s*MANUAL:START\s*-->([\s\S]*?)<!--\s*MANUAL:END\s*-->/);
	const manualNotes = manualMatch ? normalizeManualNotes(manualMatch[1]) : "";

	return {
		userProfile: sections["User Profile"] ?? "",
		keyFacts: sections["Key Facts"] ?? "",
		ongoingContext: sections["Ongoing Context"] ?? "",
		manualNotes,
		raw: markdown,
	};
}

export function generateMemory(): string {
	return `# Memory

## User Profile

*No user profile configured yet.*

## Key Facts

*No facts stored yet.*

## Ongoing Context

*No ongoing context.*

<!-- MANUAL:START -->
<!-- Add your own notes here - they will be preserved -->
<!-- MANUAL:END -->
`;
}
