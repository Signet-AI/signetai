import type { MigrationDb } from "./index";

/**
 * Migration 108: daily-aggregate embedding token usage.
 *
 * Every embedding fetch through the shared boundary (Ollama, native ONNX,
 * llama.cpp, OpenAI-compatible) records the token count of the text actually
 * sent, using the real tokenizer (countTokens) rather than provider-reported
 * usage (Ollama's /api/embeddings returns none). Rows aggregate by
 * (day, agent_id, source_kind, provider) so the table stays bounded (one row
 * per day per dimension) while still answering "how much did vault ingest
 * cost in tokens vs. captures" and "Ollama/native throughput" questions.
 *
 * `agent_id` defaults to '' when the fetch boundary had no agent context
 * (a real identity is never substituted with "default"). `requests` counts
 * successful embedding fetches; `tokens` sums the tokenizer count of the
 * text sent to the provider.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_usage (
			day TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT '',
			source_kind TEXT NOT NULL,
			provider TEXT NOT NULL,
			requests INTEGER NOT NULL DEFAULT 0,
			tokens INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (day, agent_id, source_kind, provider)
		);
	`);
}
