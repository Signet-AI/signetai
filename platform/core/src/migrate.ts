export type MigrationSource = "chatgpt" | "claude" | "gemini";

export interface MigrationOptions {
	source: MigrationSource;
	inputPath: string;
	outputPath?: string;
}

export async function migrate(options: MigrationOptions): Promise<void> {
	const { source, inputPath } = options;

	switch (source) {
		case "chatgpt":
			await migrateChatGPT(inputPath);
			break;
		case "claude":
			await migrateClaude(inputPath);
			break;
		case "gemini":
			await migrateGemini(inputPath);
			break;
		default:
			throw new Error(`Unknown migration source: ${source}`);
	}
}

async function migrateChatGPT(_inputPath: string): Promise<void> {
	// TODO: Parse ChatGPT export (conversations.json)
	// Extract: user preferences, facts mentioned, project context
	throw new Error(
		"ChatGPT migration is not yet implemented. " + "See https://github.com/Signet-AI/signetai/issues for tracking.",
	);
}

async function migrateClaude(_inputPath: string): Promise<void> {
	// TODO: Parse Claude.ai export
	throw new Error(
		"Claude.ai migration is not yet implemented. " + "See https://github.com/Signet-AI/signetai/issues for tracking.",
	);
}

async function migrateGemini(_inputPath: string): Promise<void> {
	// TODO: Parse Gemini export
	throw new Error(
		"Gemini migration is not yet implemented. " + "See https://github.com/Signet-AI/signetai/issues for tracking.",
	);
}
