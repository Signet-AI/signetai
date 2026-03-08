/**
 * Sample conversation transcripts for LLM pipeline integration tests.
 *
 * Realistic coding session transcripts that exercise the extraction,
 * decision, and summary prompts. Sized to stay well within qwen3:4b's
 * 32k context window even after prompt framing.
 */

// ---------------------------------------------------------------------------
// Small transcript (~150 words) -- quick preference + decision
// ---------------------------------------------------------------------------

export const SMALL_TRANSCRIPT = [
  "User: I've decided to switch the auth service from MongoDB to PostgreSQL.",
  "The relational queries are a better fit for our access-control schema,",
  "and we need ACID transactions for auth state changes.",
  "",
  "Assistant: That makes sense. PostgreSQL's row-level security could also",
  "help with your multi-tenant isolation requirements. I'll update the",
  "migration scripts to target PostgreSQL. Do you want me to set up",
  "pgBouncer for connection pooling as well?",
  "",
  "User: Yes, set up pgBouncer. Also, I prefer dark mode for all editor",
  "and terminal interfaces, and I use vim keybindings everywhere.",
].join("\n");

// ---------------------------------------------------------------------------
// Medium transcript (~500 words) -- multi-topic session
// ---------------------------------------------------------------------------

export const MEDIUM_TRANSCRIPT = [
  "User: Let's work on the dashboard component today. The EmbeddingCanvas2D",
  "is too slow -- it's polling for updates every 100ms which kills the GPU.",
  "",
  "Assistant: I see the issue. The polling loop in EmbeddingCanvas2D is",
  "calling requestAnimationFrame inside a setInterval, which means frames",
  "are being requested even when nothing has changed. We should switch to",
  "a reactive requestRedraw pattern -- only schedule a new frame when the",
  "underlying data actually changes.",
  "",
  "User: Exactly. Also, the force-directed graph layout is using d3-force",
  "but we should consider switching to ngraph.forcelayout for better",
  "performance with large node counts. Our test dataset has 50k nodes.",
  "",
  "Assistant: Good call. ngraph.forcelayout handles large graphs much",
  "better because it uses a Barnes-Hut approximation by default.",
  "d3-force's quadtree approximation starts degrading around 10k nodes.",
  "I'll benchmark both with your 50k dataset.",
  "",
  "User: The other thing -- the skills management page needs a search bar.",
  "Right now you have to scroll through the entire list to find anything.",
  "Use the existing SearchInput component from shadcn-svelte.",
  "",
  "Assistant: I'll add a fuzzy search using the SearchInput component.",
  "Should I also add tag-based filtering? The skills already have tags",
  "in their manifests.",
  "",
  "User: Yes, add tag filtering too. And make sure the search is debounced",
  "at 300ms so we don't hammer the API on every keystroke.",
  "",
  "Assistant: Done. I've also noticed that the memory timeline chart is",
  "breaking when there are more than 1000 entries because the SVG path",
  "becomes too long. I'll switch it to canvas rendering for the line chart.",
  "",
  "User: Good catch. One more thing -- the daemon's update checker is",
  "hitting the npm registry too often. It should check at most once every",
  "24 hours, not every hour. Update the default interval in update-system.ts.",
].join("\n");

// ---------------------------------------------------------------------------
// Large transcript (~1000 words) -- deep architecture discussion
// ---------------------------------------------------------------------------

export const LARGE_TRANSCRIPT = [
  "User: I want to redesign the memory pipeline's retry mechanism.",
  "Right now when a job fails, it goes back to 'pending' immediately",
  "which means the worker retries it on the next tick. That's too aggressive.",
  "",
  "Assistant: Agreed. The current behavior can create a tight retry loop",
  "that wastes LLM inference capacity. I'd suggest exponential backoff",
  "with jitter. Something like: delay = min(base * 2^attempts, maxDelay)",
  "plus random(0, jitter). Base of 5 seconds, max of 120 seconds.",
  "",
  "User: That's exactly what I was thinking. Implement it in the worker.",
  "Also, we need to add a dead-letter mechanism. After max_attempts,",
  "the job should go to 'dead' status instead of staying 'pending' forever.",
  "",
  "Assistant: I'll implement both. For the dead-letter queue, should we",
  "also add an API endpoint to requeue dead jobs? That way you can manually",
  "retry them after fixing the underlying issue.",
  "",
  "User: Yes, add /api/repair/requeue-dead. Make it require auth.",
  "",
  "Assistant: Noted. On a related topic, I've been looking at the",
  "embedding dimension mismatch issue. When the embedding provider changes",
  "(say from nomic-embed-text at 768d to text-embedding-3-small at 1536d),",
  "all existing embeddings become incompatible. We need a migration path.",
  "",
  "User: We should track the embedding model per-memory and refuse to",
  "compare vectors from different models. Add an embedding_model column",
  "to the memories table if it's not there already.",
  "",
  "Assistant: It's already there from migration 007. But the pipeline",
  "doesn't consistently set it. I'll audit all insert paths and make sure",
  "embedding_model is always populated when a vector is stored.",
  "",
  "User: Perfect. The other big thing is session continuity scoring. After",
  "each session, the summary worker should evaluate how well the pre-loaded",
  "memories served the conversation. Score from 0 to 1, where 1 means",
  "memories perfectly covered all needed context.",
  "",
  "Assistant: I like this. We can use the LLM to analyze the transcript",
  "and pre-loaded memories together. The prompt would ask: were any memories",
  "relevant? Did the user have to re-explain things? Were there gaps?",
  "",
  "User: Exactly. Store the scores in a session_scores table. Include",
  "the score, confidence, number of memories used vs recalled, novel",
  "context count, and reasoning. We'll track trends over time.",
  "",
  "Assistant: I'll design the schema and implement it as part of the",
  "summary worker flow. The scoring happens after the summary is written",
  "so it has the full session context available.",
  "",
  "User: One more architecture decision -- the connector framework.",
  "Connectors should be idempotent. Running install multiple times should",
  "produce the same result. No duplicate symlinks, no duplicate config entries.",
  "",
  "Assistant: Makes sense for a CLI tool that users might run repeatedly.",
  "I'll add idempotency guards to the connector install methods. For",
  "symlinks, check if the target already exists and points to the right",
  "place. For config entries, use upsert semantics instead of blind appends.",
  "",
  "User: Also -- the @signet/connector-opencode install() function should",
  "write the pre-bundled signet.mjs plugin to ~/.config/opencode/plugins/.",
  "Make sure it creates the directory if it doesn't exist.",
  "",
  "Assistant: Got it. I'll use mkdirSync with recursive: true before",
  "writing the file. And I'll add a hash check so we only overwrite the",
  "plugin if the content has actually changed, to avoid unnecessary file",
  "writes that would trigger watchers.",
].join("\n");

// ---------------------------------------------------------------------------
// Edge case: empty-ish transcript
// ---------------------------------------------------------------------------

export const MINIMAL_TRANSCRIPT = "User: hi\nAssistant: hello";

// ---------------------------------------------------------------------------
// Edge case: unicode-heavy transcript
// ---------------------------------------------------------------------------

export const UNICODE_TRANSCRIPT = [
  "User: The error message shows \u201cUnicode\u2019s tricky \u2014 especially with CJK characters\u201d.",
  "We need to handle \u65e5\u672c\u8a9e (Japanese), \ud55c\uad6d\uc5b4 (Korean), and \u4e2d\u6587 (Chinese) in memory content.",
  "",
  "Assistant: I'll add proper Unicode normalization using NFC form before",
  "hashing. The content_hash should be stable regardless of whether the",
  "input uses composed or decomposed Unicode characters. For CJK text,",
  "we also need to handle full-width vs half-width variants.",
  "",
  "User: Good. Also handle emoji in memory content: \ud83d\ude80 \ud83d\udcbb \ud83d\udd27",
  "Some users put emoji in their notes and we shouldn't strip them.",
].join("\n");
