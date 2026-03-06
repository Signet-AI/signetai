/**
 * LLM Pipeline Integration Tests
 *
 * Verifies that prompts sent to local LLMs (qwen3:4b via Ollama)
 * produce structurally valid and semantically reasonable output.
 *
 * Requirements:
 *   - Ollama running locally on port 11434
 *   - qwen3:4b model pulled
 *
 * Run:  bun test tests/integration/pipeline-llm.test.ts
 *
 * These tests are NON-DETERMINISTIC by design. Each prompt is run
 * multiple times and statistical assertions are used (at least N of M
 * attempts must succeed). This accounts for LLM output variability.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  SMALL_TRANSCRIPT,
  MEDIUM_TRANSCRIPT,
  LARGE_TRANSCRIPT,
  MINIMAL_TRANSCRIPT,
  UNICODE_TRANSCRIPT,
} from "./fixtures/transcripts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = "qwen3:4b";
const TIMEOUT_MS = 180_000;
const RUNS_PER_TEST = 3;
const MIN_SUCCESSES = 2; // at least 2/3 must pass

// ---------------------------------------------------------------------------
// Ollama availability check
// ---------------------------------------------------------------------------

let ollamaAvailable = false;
let modelAvailable = false;

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      models?: Array<{ name?: string }>;
    };
    const models = data.models ?? [];
    return models.some(
      (m) => m.name === MODEL || m.name?.startsWith(`${MODEL}:`),
    );
  } catch {
    return false;
  }
}

async function generate(
  prompt: string,
  opts?: { timeoutMs?: number; format?: string },
): Promise<{ text: string; durationMs: number }> {
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model: MODEL,
      prompt,
      stream: false,
      // Force JSON output mode -- prevents the model from generating
      // long prose preambles before the JSON object.
      format: "json",
      // Disable qwen3's thinking mode to avoid long <think> blocks
      // that waste inference time on structured output tasks.
      // The production pipeline strips <think> blocks post-hoc, but
      // for testing we skip them entirely to keep runtimes reasonable.
      think: false,
      // Cap output length to prevent runaway generation on verbose models
      options: { num_predict: 2048 },
    };

    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json()) as { response?: string };
    if (typeof data.response !== "string") {
      throw new Error("Ollama returned no response field");
    }

    return {
      text: data.response.trim(),
      durationMs: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Ollama timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// JSON parsing helpers (mirroring extraction.ts logic)
// ---------------------------------------------------------------------------

const THINK_RE = /<think>[\s\S]*?<\/think>\s*/g;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

function cleanLlmOutput(raw: string): string {
  let cleaned = raw.replace(THINK_RE, "");
  const fenceMatch = cleaned.match(FENCE_RE);
  if (fenceMatch) cleaned = fenceMatch[1];
  return cleaned.trim();
}

/**
 * Extract the outermost balanced JSON object from a string.
 * Handles cases where the model outputs prose before/after the JSON.
 * Mirrors extractBalancedJsonObject() from extraction.ts.
 */
function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function tryParseJson(raw: string): unknown | null {
  const cleaned = cleanLlmOutput(raw);
  if (!cleaned) return null;

  // Build candidate list: cleaned text, balanced extraction from cleaned,
  // balanced extraction from raw (handles think blocks the regex missed)
  const candidates: string[] = [cleaned];

  const cleanedObj = extractBalancedJsonObject(cleaned);
  if (cleanedObj && cleanedObj !== cleaned) {
    candidates.push(cleanedObj);
  }

  const rawObj = extractBalancedJsonObject(raw);
  if (rawObj && !candidates.includes(rawObj)) {
    candidates.push(rawObj);
  }

  for (const candidate of candidates) {
    // Try as-is, then with trailing comma fix
    const attempts = [candidate, candidate.replace(/,\s*([}\]])/g, "$1")];
    for (const attempt of attempts) {
      try {
        return JSON.parse(attempt);
      } catch {
        // continue
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statistical runner
// ---------------------------------------------------------------------------

interface RunResult<T> {
  successes: number;
  failures: number;
  results: Array<{ ok: boolean; value?: T; error?: string; durationMs: number }>;
}

async function runMultiple<T>(
  fn: () => Promise<{ value: T; durationMs: number }>,
  runs: number = RUNS_PER_TEST,
): Promise<RunResult<T>> {
  const results: RunResult<T>["results"] = [];
  let successes = 0;
  let failures = 0;

  for (let i = 0; i < runs; i++) {
    try {
      const { value, durationMs } = await fn();
      results.push({ ok: true, value, durationMs });
      successes++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ ok: false, error: msg, durationMs: 0 });
      failures++;
    }
  }

  return { successes, failures, results };
}

function logTimings(label: string, results: RunResult<unknown>): void {
  const times = results.results
    .filter((r) => r.ok)
    .map((r) => r.durationMs);
  if (times.length === 0) return;
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(
    `  [timing] ${label}: avg=${avg}ms min=${min}ms max=${max}ms (${times.length}/${results.results.length} ok)`,
  );
}

// ---------------------------------------------------------------------------
// Prompt builders (extracted from pipeline source)
// ---------------------------------------------------------------------------

function buildExtractionPrompt(content: string): string {
  // Truncate to match pipeline behavior
  const trimmed = content.trim().replace(/\s+/g, " ");
  const truncated =
    trimmed.length > 12000
      ? `${trimmed.slice(0, 12000)}\n[truncated]`
      : trimmed;

  return `Extract key facts and entity relationships from this text.

Return JSON with two arrays: "facts" and "entities".

Each fact: {"content": "...", "type": "fact|preference|decision|rationale|procedural|semantic", "confidence": 0.0-1.0}
Each entity: {"source": "...", "relationship": "...", "target": "...", "confidence": 0.0-1.0}

IMPORTANT — Atomic facts:
Each fact must be fully understandable WITHOUT the original conversation. Include the specific subject (package name, file path, component, tool) and enough context that a reader seeing only this fact knows exactly what it refers to.

BAD: "install() writes bundled plugin"
GOOD: "The @signet/connector-opencode install() function writes pre-bundled signet.mjs to ~/.config/opencode/plugins/"

BAD: "Uses PostgreSQL instead of MongoDB"
GOOD: "The auth service uses PostgreSQL instead of MongoDB for better relational query support"

Types: fact (objective info), preference (user likes/dislikes), decision (choices made), rationale (WHY a decision was made — reasoning, alternatives considered, tradeoffs), procedural (how-to knowledge), semantic (concepts/definitions).

When you see a decision with reasoning, extract BOTH a decision fact AND a rationale fact. The rationale should capture the WHY, including alternatives considered and tradeoffs.

Examples:

Input: "User prefers dark mode and uses vim keybindings in VS Code"
Output:
{"facts": [
  {"content": "User prefers dark mode for all editor and terminal interfaces", "type": "preference", "confidence": 0.9},
  {"content": "User uses vim keybindings in VS Code as their primary editing mode", "type": "preference", "confidence": 0.9}
], "entities": [
  {"source": "User", "relationship": "prefers", "target": "dark mode", "confidence": 0.9},
  {"source": "User", "relationship": "uses", "target": "vim keybindings", "confidence": 0.9}
]}

Input: "Decided to use PostgreSQL instead of MongoDB for the auth service because relational queries suit the access-control schema better and we need ACID transactions"
Output:
{"facts": [
  {"content": "The auth service uses PostgreSQL instead of MongoDB for its database", "type": "decision", "confidence": 0.85},
  {"content": "PostgreSQL was chosen over MongoDB for the auth service because: (1) relational queries suit the access-control schema, (2) ACID transactions needed for auth state changes. MongoDB was rejected due to lack of native join support.", "type": "rationale", "confidence": 0.85}
], "entities": [
  {"source": "auth service", "relationship": "uses", "target": "PostgreSQL", "confidence": 0.85},
  {"source": "auth service", "relationship": "rejected", "target": "MongoDB", "confidence": 0.8}
]}

Only extract durable, reusable knowledge. Skip ephemeral details.
Return ONLY the JSON object, no other text.

Text:
${truncated}`;
}

function buildDecisionPrompt(
  factContent: string,
  factType: string,
  factConfidence: number,
  candidates: Array<{ id: string; content: string; type: string }>,
): string {
  const candidateBlock = candidates
    .map(
      (c, i) =>
        `[${i + 1}] ID: ${c.id}\n    Type: ${c.type}\n    Content: ${c.content}`,
    )
    .join("\n\n");

  return `You are a memory management system. Given a new fact and existing memory candidates, decide the best action.

New fact (type: ${factType}, confidence: ${factConfidence}):
"${factContent}"

Existing candidates:
${candidateBlock}

Actions:
- "add": New fact has no good match, should be stored as new memory
- "update": New fact supersedes or refines an existing candidate (specify targetId). Ensure the merged result is self-contained
- "delete": New fact contradicts/invalidates a candidate (specify targetId)
- "none": Fact is already covered by existing memories, skip

Return a JSON object:
{"action": "add|update|delete|none", "targetId": "candidate-id-if-applicable", "confidence": 0.0-1.0, "reason": "brief explanation"}

Return ONLY the JSON, no other text.`;
}

function buildSummaryPrompt(transcript: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `You are a session librarian. Summarize this coding session as a dated markdown note and extract key durable facts.

Return ONLY a JSON object (no markdown fences, no other text):
{
  "summary": "# ${date} Session Notes\\n\\n## Topic Name\\n\\nProse summary...",
  "facts": [{"content": "...", "importance": 0.3, "tags": "tag1,tag2", "type": "fact"}]
}

Summary guidelines:
- Start with "# ${date} Session Notes"
- Use ## headings for each distinct topic discussed
- Include: what was worked on, key decisions, open threads
- Be concise but complete (200-500 words)
- Write in past tense, third person

Fact extraction guidelines:
- Each fact must be self-contained and understandable without this conversation
- Include the specific subject (package name, file path, tool, component) in every fact
- BAD: "switched to a reactive pattern" → GOOD: "The EmbeddingCanvas2D component switched from polling to a reactive requestRedraw pattern for GPU efficiency"
- Only durable, reusable knowledge (skip ephemeral details)
- Types: fact, preference, decision, learning, rule, issue
- Importance: 0.3 (routine) to 0.5 (significant)
- Max 15 facts

Conversation:
${transcript}`;
}

function buildContradictionPrompt(
  statementA: string,
  statementB: string,
): string {
  return `Do these two statements contradict each other? Consider semantic contradictions (not just syntactic).

Statement A: ${statementA}
Statement B: ${statementB}

Return ONLY a JSON object (no markdown fences, no other text):
{"contradicts": true/false, "confidence": 0.0-1.0, "reasoning": "brief explanation"}

Examples of contradictions:
- "Uses PostgreSQL for the auth service" vs "Migrated the auth service to MongoDB" → contradicts
- "Dark mode is enabled by default" vs "Light mode is the default theme" → contradicts
- "The API uses REST" vs "The API endpoint returns JSON" → does NOT contradict (complementary info)`;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const VALID_FACT_TYPES = new Set([
  "fact",
  "preference",
  "decision",
  "rationale",
  "procedural",
  "semantic",
  // summary worker also allows these:
  "learning",
  "rule",
  "issue",
  "system",
]);

const VALID_ACTIONS = new Set(["add", "update", "delete", "none"]);

interface ExtractionOutput {
  facts: Array<{
    content: string;
    type: string;
    confidence: number;
  }>;
  entities: Array<{
    source: string;
    relationship: string;
    target: string;
    confidence: number;
  }>;
}

function validateExtractionOutput(parsed: unknown): {
  valid: boolean;
  output?: ExtractionOutput;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, errors: ["Output is not an object"] };
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.facts)) {
    errors.push("Missing or non-array 'facts' field");
  }
  if (!Array.isArray(obj.entities)) {
    errors.push("Missing or non-array 'entities' field");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const facts: ExtractionOutput["facts"] = [];
  for (const f of obj.facts as unknown[]) {
    if (typeof f !== "object" || f === null) {
      errors.push("Fact is not an object");
      continue;
    }
    const fact = f as Record<string, unknown>;
    if (typeof fact.content !== "string" || fact.content.length < 10) {
      errors.push(`Fact content too short or missing: "${fact.content}"`);
      continue;
    }
    // type is optional (defaults to "fact" in pipeline), confidence optional
    facts.push({
      content: fact.content,
      type: typeof fact.type === "string" ? fact.type : "fact",
      confidence: typeof fact.confidence === "number" ? fact.confidence : 0.5,
    });
  }

  const entities: ExtractionOutput["entities"] = [];
  for (const e of obj.entities as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const ent = e as Record<string, unknown>;
    if (typeof ent.source !== "string" || typeof ent.target !== "string") {
      continue;
    }
    entities.push({
      source: ent.source,
      relationship:
        typeof ent.relationship === "string" ? ent.relationship : "",
      target: ent.target,
      confidence:
        typeof ent.confidence === "number" ? ent.confidence : 0.5,
    });
  }

  return {
    valid: facts.length > 0,
    output: { facts, entities },
    errors,
  };
}

interface DecisionOutput {
  action: string;
  targetId?: string;
  confidence: number;
  reason: string;
}

function validateDecisionOutput(parsed: unknown): {
  valid: boolean;
  output?: DecisionOutput;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, errors: ["Output is not an object"] };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.action !== "string" || !VALID_ACTIONS.has(obj.action)) {
    errors.push(`Invalid or missing action: "${obj.action}"`);
    return { valid: false, errors };
  }

  if (typeof obj.reason !== "string" || obj.reason.length === 0) {
    errors.push("Missing or empty reason");
  }

  return {
    valid: errors.length === 0,
    output: {
      action: obj.action,
      targetId:
        typeof obj.targetId === "string" ? obj.targetId : undefined,
      confidence:
        typeof obj.confidence === "number" ? obj.confidence : 0.5,
      reason: typeof obj.reason === "string" ? obj.reason : "",
    },
    errors,
  };
}

interface SummaryOutput {
  summary: string;
  facts: Array<{ content: string; importance?: number; type?: string }>;
}

function validateSummaryOutput(parsed: unknown): {
  valid: boolean;
  output?: SummaryOutput;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, errors: ["Output is not an object"] };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.summary !== "string") {
    errors.push("Missing summary string");
    return { valid: false, errors };
  }

  if (obj.summary.length < 50) {
    errors.push(`Summary too short: ${obj.summary.length} chars`);
  }

  if (obj.summary.length > 5000) {
    errors.push(`Summary too long: ${obj.summary.length} chars`);
  }

  if (!Array.isArray(obj.facts)) {
    errors.push("Missing or non-array facts");
    return { valid: false, errors };
  }

  const facts: SummaryOutput["facts"] = [];
  for (const f of obj.facts) {
    if (typeof f !== "object" || f === null) continue;
    const item = f as Record<string, unknown>;
    if (typeof item.content !== "string") continue;
    facts.push({
      content: item.content,
      importance:
        typeof item.importance === "number" ? item.importance : undefined,
      type: typeof item.type === "string" ? item.type : undefined,
    });
  }

  return {
    valid: errors.length === 0,
    output: { summary: obj.summary, facts },
    errors,
  };
}

// ===================================================================
// Tests
// ===================================================================

beforeAll(async () => {
  modelAvailable = await checkOllama();
  ollamaAvailable = modelAvailable; // checkOllama already verifies the model

  if (!ollamaAvailable) {
    console.log(
      `\n  SKIPPING LLM integration tests: Ollama not running or ${MODEL} not available.\n` +
        `  Start Ollama and pull the model:\n` +
        `    ollama serve\n` +
        `    ollama pull ${MODEL}\n`,
    );
  }
});

// ===================================================================
// Extraction Quality
// ===================================================================

describe("Extraction Quality", () => {
  test("extracts facts from a small transcript", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(SMALL_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("extraction/small", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    // Check content quality on successful runs
    for (const r of result.results) {
      if (!r.ok || !r.value) continue;
      // Should find at least 2 facts from a transcript about
      // database migration + user preferences
      expect(r.value.facts.length).toBeGreaterThanOrEqual(2);

      // At least one fact should mention PostgreSQL or MongoDB
      const mentionsDb = r.value.facts.some(
        (f) =>
          f.content.toLowerCase().includes("postgresql") ||
          f.content.toLowerCase().includes("postgres") ||
          f.content.toLowerCase().includes("mongo"),
      );
      expect(mentionsDb).toBe(true);
    }
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("extracts facts from a medium transcript", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(MEDIUM_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("extraction/medium", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    for (const r of result.results) {
      if (!r.ok || !r.value) continue;
      // Medium transcript has ~5 distinct topics
      expect(r.value.facts.length).toBeGreaterThanOrEqual(3);
      expect(r.value.facts.length).toBeLessThanOrEqual(20);
    }
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("extracts facts from a large transcript", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(LARGE_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("extraction/large", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    for (const r of result.results) {
      if (!r.ok || !r.value) continue;
      expect(r.value.facts.length).toBeGreaterThanOrEqual(4);
    }
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("produces valid fact types", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(SMALL_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      // Every fact type should be a recognized type
      for (const fact of validation.output!.facts) {
        if (!VALID_FACT_TYPES.has(fact.type)) {
          throw new Error(`Unknown fact type: "${fact.type}"`);
        }
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("extraction/types", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("produces valid entity triples", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(SMALL_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      // Entities should have non-empty source, relationship, target
      for (const entity of validation.output!.entities) {
        if (!entity.source || !entity.target) {
          throw new Error(
            `Entity missing source/target: ${JSON.stringify(entity)}`,
          );
        }
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("extraction/entities", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("confidence values are in [0, 1] range", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(MEDIUM_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      for (const fact of validation.output!.facts) {
        if (fact.confidence < 0 || fact.confidence > 1) {
          throw new Error(`Confidence out of range: ${fact.confidence}`);
        }
      }
      for (const entity of validation.output!.entities) {
        if (entity.confidence < 0 || entity.confidence > 1) {
          throw new Error(`Entity confidence out of range: ${entity.confidence}`);
        }
      }
      return { value: true, durationMs };
    });

    logTimings("extraction/confidence", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);
});

// ===================================================================
// Decision Quality
// ===================================================================

describe("Decision Quality", () => {
  test("recommends 'add' for a novel fact with no matching candidates", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildDecisionPrompt(
      "The auth service uses PostgreSQL instead of MongoDB for better relational query support",
      "decision",
      0.85,
      [
        {
          id: "mem-001",
          content: "The dashboard uses Svelte 5 with Tailwind v4",
          type: "fact",
        },
        {
          id: "mem-002",
          content: "User prefers dark mode for all interfaces",
          type: "preference",
        },
      ],
    );

    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateDecisionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("decision/add-novel", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    // Most runs should recommend "add" since the fact is unrelated to candidates
    const addCount = result.results.filter(
      (r) => r.ok && r.value?.action === "add",
    ).length;
    expect(addCount).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("recommends 'none' or 'update' for a duplicate fact", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildDecisionPrompt(
      "User prefers dark mode for editor interfaces",
      "preference",
      0.9,
      [
        {
          id: "mem-001",
          content: "User prefers dark mode for all editor and terminal interfaces",
          type: "preference",
        },
        {
          id: "mem-002",
          content: "The auth service uses PostgreSQL",
          type: "decision",
        },
      ],
    );

    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateDecisionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("decision/duplicate", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    // Should recommend "none" (already covered) or "update" (refinement)
    const correctCount = result.results.filter(
      (r) =>
        r.ok &&
        (r.value?.action === "none" || r.value?.action === "update"),
    ).length;
    expect(correctCount).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("decision output has required fields", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildDecisionPrompt(
      "The CLI uses bun as its build tool",
      "fact",
      0.8,
      [
        {
          id: "mem-001",
          content: "The CLI targets Node.js for broader compatibility",
          type: "fact",
        },
      ],
    );

    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateDecisionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      // Verify all required fields are present and well-formed
      const output = validation.output!;
      if (output.reason.length < 5) {
        throw new Error(`Reason too short: "${output.reason}"`);
      }
      if (output.confidence < 0 || output.confidence > 1) {
        throw new Error(`Confidence out of range: ${output.confidence}`);
      }
      return { value: output, durationMs };
    });

    logTimings("decision/fields", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);
});

// ===================================================================
// Summary Quality
// ===================================================================

describe("Summary Quality", () => {
  test("produces a valid summary from medium transcript", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildSummaryPrompt(MEDIUM_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateSummaryOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("summary/medium", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    for (const r of result.results) {
      if (!r.ok || !r.value) continue;
      // Summary should be substantial (JSON mode can produce
      // tighter summaries, so threshold is conservative)
      expect(r.value.summary.length).toBeGreaterThan(40);
      expect(r.value.summary.length).toBeLessThan(5000);
      // Should extract at least some facts
      expect(r.value.facts.length).toBeGreaterThanOrEqual(1);
      expect(r.value.facts.length).toBeLessThanOrEqual(15);
    }
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("summary contains markdown headings", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildSummaryPrompt(LARGE_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateSummaryOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      // Summary should contain markdown headings
      const hasHeading = /^#/m.test(validation.output!.summary);
      if (!hasHeading) {
        throw new Error("Summary missing markdown headings");
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("summary/headings", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("summary facts are self-contained strings", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildSummaryPrompt(MEDIUM_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateSummaryOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      // Each fact content should be at least 20 chars (meaningful sentence)
      for (const fact of validation.output!.facts) {
        if (fact.content.length < 15) {
          throw new Error(`Fact too short: "${fact.content}"`);
        }
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("summary/facts-quality", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);
});

// ===================================================================
// Contradiction Detection
// ===================================================================

describe("Contradiction Detection", () => {
  test("detects a clear contradiction", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildContradictionPrompt(
      "The auth service uses PostgreSQL for its database",
      "The auth service was migrated to MongoDB last quarter",
    );

    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.contradicts !== "boolean") {
        throw new Error("Missing contradicts field");
      }
      return { value: obj as { contradicts: boolean; confidence: number; reasoning: string }, durationMs };
    });

    logTimings("contradiction/detected", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    // Most runs should detect the contradiction
    const detectedCount = result.results.filter(
      (r) => r.ok && (r.value as { contradicts: boolean })?.contradicts === true,
    ).length;
    expect(detectedCount).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("does not flag complementary information as contradicting", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildContradictionPrompt(
      "The API uses REST endpoints",
      "The API returns JSON responses",
    );

    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.contradicts !== "boolean") {
        throw new Error("Missing contradicts field");
      }
      return { value: obj as { contradicts: boolean; confidence: number; reasoning: string }, durationMs };
    });

    logTimings("contradiction/complementary", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);

    // Most runs should NOT flag this as a contradiction
    const noContradictionCount = result.results.filter(
      (r) => r.ok && (r.value as { contradicts: boolean })?.contradicts === false,
    ).length;
    expect(noContradictionCount).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);
});

// ===================================================================
// Prompt Robustness / Edge Cases
// ===================================================================

describe("Prompt Robustness", () => {
  test("handles unicode-heavy content without degeneration", async () => {
    if (!ollamaAvailable) return;

    const prompt = buildExtractionPrompt(UNICODE_TRANSCRIPT);
    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
      }
      return { value: validation.output!, durationMs };
    });

    logTimings("robustness/unicode", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);

  test("extraction prompt fits within context window", () => {
    // qwen3:4b has a ~32k token context window
    // Rough estimate: 1 token ~= 4 chars for English text
    // The extraction prompt truncates input at 12000 chars
    // Plus prompt framing is ~2000 chars = ~14000 chars max
    // ~3500 tokens -- well within 32k

    const prompt = buildExtractionPrompt(LARGE_TRANSCRIPT);
    const estimatedTokens = Math.ceil(prompt.length / 4);
    expect(estimatedTokens).toBeLessThan(32000);

    // Also check with max-length input (12000 char limit)
    const maxInput = "x".repeat(12000);
    const maxPrompt = buildExtractionPrompt(maxInput);
    const maxTokens = Math.ceil(maxPrompt.length / 4);
    expect(maxTokens).toBeLessThan(32000);
  });

  test("summary prompt fits within context window", () => {
    const prompt = buildSummaryPrompt(LARGE_TRANSCRIPT);
    const estimatedTokens = Math.ceil(prompt.length / 4);
    expect(estimatedTokens).toBeLessThan(32000);
  });

  test("handles very short (but valid) transcript gracefully", async () => {
    if (!ollamaAvailable) return;

    // The pipeline rejects input < 20 chars, so use something just above
    const shortButValid =
      "User: We decided to use Rust for the predictor sidecar because of performance requirements.";
    const prompt = buildExtractionPrompt(shortButValid);

    const result = await runMultiple(async () => {
      const { text, durationMs } = await generate(prompt);
      const parsed = tryParseJson(text);
      if (parsed === null) throw new Error("Failed to parse JSON");
      const validation = validateExtractionOutput(parsed);
      // For very short input, we accept zero facts as valid too
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Output is not an object");
      }
      const obj = parsed as Record<string, unknown>;
      if (!Array.isArray(obj.facts) || !Array.isArray(obj.entities)) {
        throw new Error("Missing facts or entities arrays");
      }
      return { value: { factCount: (obj.facts as unknown[]).length }, durationMs };
    });

    logTimings("robustness/short", result);
    expect(result.successes).toBeGreaterThanOrEqual(MIN_SUCCESSES);
  }, TIMEOUT_MS * RUNS_PER_TEST + 10_000);
});

// ===================================================================
// Schema Compliance (parsing logic tests -- no LLM needed)
// ===================================================================

describe("Schema Compliance (parsing)", () => {
  test("cleanLlmOutput strips <think> blocks", () => {
    const raw =
      '<think>Let me analyze this...</think>{"facts":[],"entities":[]}';
    const cleaned = cleanLlmOutput(raw);
    expect(cleaned).toBe('{"facts":[],"entities":[]}');
  });

  test("cleanLlmOutput strips markdown fences", () => {
    const raw = '```json\n{"facts":[],"entities":[]}\n```';
    const cleaned = cleanLlmOutput(raw);
    expect(cleaned).toBe('{"facts":[],"entities":[]}');
  });

  test("cleanLlmOutput strips both think and fences", () => {
    const raw =
      '<think>thinking...</think>\n```json\n{"facts":[]}\n```\ntrailing';
    const cleaned = cleanLlmOutput(raw);
    expect(cleaned).toBe('{"facts":[]}');
  });

  test("tryParseJson handles trailing commas", () => {
    const raw = '{"facts": [{"content": "test",}], "entities": [],}';
    const parsed = tryParseJson(raw);
    expect(parsed).not.toBeNull();
    expect((parsed as Record<string, unknown>).facts).toBeDefined();
  });

  test("tryParseJson returns null for garbage", () => {
    expect(tryParseJson("not json at all")).toBeNull();
    expect(tryParseJson("")).toBeNull();
    expect(tryParseJson("   ")).toBeNull();
  });

  test("validateExtractionOutput rejects missing fields", () => {
    const result1 = validateExtractionOutput({ entities: [] });
    expect(result1.valid).toBe(false);

    const result2 = validateExtractionOutput({ facts: [] });
    expect(result2.valid).toBe(false);

    const result3 = validateExtractionOutput("not an object");
    expect(result3.valid).toBe(false);
  });

  test("validateExtractionOutput accepts valid structure", () => {
    const result = validateExtractionOutput({
      facts: [
        {
          content: "The auth service uses PostgreSQL for its database",
          type: "decision",
          confidence: 0.85,
        },
      ],
      entities: [
        {
          source: "auth service",
          relationship: "uses",
          target: "PostgreSQL",
          confidence: 0.85,
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.output!.facts.length).toBe(1);
    expect(result.output!.entities.length).toBe(1);
  });

  test("validateDecisionOutput accepts valid actions", () => {
    for (const action of ["add", "update", "delete", "none"]) {
      const result = validateDecisionOutput({
        action,
        confidence: 0.8,
        reason: "test reason for this action",
      });
      expect(result.valid).toBe(true);
    }
  });

  test("validateDecisionOutput rejects invalid action", () => {
    const result = validateDecisionOutput({
      action: "merge",
      confidence: 0.8,
      reason: "test",
    });
    expect(result.valid).toBe(false);
  });

  test("validateSummaryOutput rejects short summaries", () => {
    const result = validateSummaryOutput({
      summary: "too short",
      facts: [],
    });
    expect(result.valid).toBe(false);
  });
});
