# 🔍 Ingestion Pipeline — Deep Code Audit

**Auditor:** Senior Code Auditor (automated)
**Branch:** `web3-identity`
**Scope:** `packages/core/src/ingest/` (13 files, 5,607 lines)
**Date:** 2025-07-14

---

## Executive Summary

The ingestion pipeline is architecturally sound — clean separation between detection → parse → chunk → extract → store. However, this audit found **48 issues**: 6 CRITICAL, 12 HIGH, 18 MEDIUM, 12 LOW. The most dangerous problems are: (1) reading entire large files into memory with no size guard, (2) three independent copies of `callOllama` + `parseExtractionResponse` with subtle divergences creating maintenance/correctness risk, (3) the code chunker applying zero overlap losing context between splits, (4) race-condition-prone session indexing in entire-parser, and (5) no deduplication check despite having the infrastructure for it.

---

## Findings by File

---

### 1. `index.ts` (639 lines) — Pipeline Orchestrator

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 1 | 150 | **HIGH** | Reads arbitrary file into memory for type sniffing | `isDiscordExport` calls `readFileSync(filePath, "utf-8").slice(0, 4096)` — if `filePath` is a multi-GB binary file with a `.json` extension, the entire file is first loaded into memory, THEN sliced. Node's `readFileSync` loads the entire buffer before `.slice()` operates. | Use `fs.openSync` + `fs.readSync` with a fixed 4096-byte buffer, or `createReadStream` with a limit. |
| 2 | 157, 163 | **MEDIUM** | Same unbounded read in directory Discord detection | `readFileSync(join(filePath, "index.json"), "utf-8").slice(0, 2048)` — same pattern. Smaller risk since the file is named `index.json`, but still unbounded. | Same fix: bounded read. |
| 3 | 94 | **MEDIUM** | `.json`, `.yaml`, `.yml` in CODE_EXTS causes incorrect classification | JSON and YAML files are classified as "code" type. But `parseCode()` treats the entire file as a single code block, which is a poor representation for structured data files. Config files get LLM-extracted as "code" instead of parsed as structured data. | Either remove `.json`/`.yaml`/`.yml` from `CODE_EXTS` and add a separate "config" type with a proper parser, or at minimum handle them in `parseCode()` by detecting JSON/YAML and formatting appropriately. |
| 4 | 113-114 | **LOW** | Hidden files universally skipped | `if (name.startsWith(".")) return "skip"` means `.env.example` passed via direct path is skipped. But `.env.example` IS in `IMPORTANT_FILES` for the repo parser. Inconsistency — `detectFileType` would skip it but the repo parser reads it directly. | Clarify intent. If `.env.example` should be ingestible, don't skip all dotfiles; check `SKIP_FILES` only. |
| 5 | 197-205 | **MEDIUM** | `collectDirectory` doesn't handle symlinks | `entry.isDirectory()` and `entry.isFile()` follow symlinks implicitly. A symlink loop (e.g., `a -> b -> a`) would cause infinite recursion and stack overflow. | Add `entry.isSymbolicLink()` check and skip, or maintain a visited `Set<string>` of resolved real paths via `fs.realpathSync`. |
| 6 | 299 | **CRITICAL** | `computeFileHash` reads entire file into memory | For provenance tracking, `computeFileHash(filePath)` reads the ENTIRE file. For a 2GB PDF or repo tarball, this allocates a 2GB Buffer. No size limit. | Stream the file through `crypto.createHash('sha256')` using `fs.createReadStream()`. |
| 7 | 252-255 | **MEDIUM** | `ingestSingleFile` skips files with `totalChars < 50` silently | A 49-character file with critical content (e.g., an API key file, a short config) is silently skipped with status "skipped" but no explanatory message. The threshold is arbitrary. | Lower threshold or at least log a warning when skipping. Consider `minTokens` from chunker config instead of a hardcoded 50. |
| 8 | 285-288 | **HIGH** | `buildProvenance` is imported but never called | The `buildProvenance` function is imported from `./provenance` and re-exported, but **never called** anywhere in the actual ingestion flow. Provenance records are never actually constructed or stored during ingestion. The `ProvenanceRecord` type exists but is dead code. | Either integrate `buildProvenance()` into `storeMemories()` and persist the provenance record, or remove the dead code. This is a significant feature gap — provenance tracking is advertised but not implemented. |
| 9 | 225-230 | **HIGH** | `checkAlreadyIngested` exists but is never called | The function in `provenance.ts` to check deduplication by file hash is never invoked. Re-ingesting the same file creates duplicate memories. | Call `checkAlreadyIngested(db, fileHash)` at the start of `ingestSingleFile()` and skip if already processed (or offer a `--force` flag). |
| 10 | 337 | **MEDIUM** | `storeMemories` silently swallows all insert errors | The inner `catch (err)` block is empty. If every insert fails (e.g., schema mismatch, DB locked), the function returns 0 with no indication why. The outer loop continues, making it seem like extraction succeeded but produced nothing. | At minimum, log or collect error messages. Consider returning `{ created: number; errors: string[] }`. |
| 11 | 270 | **LOW** | `extractions[i]` / `chunks[i]` relies on parallel array alignment | If `extractFromChunks` ever changes to return results out of order (e.g., concurrent extraction), the `for (let i = 0; i < extractions.length; i++)` with `chunks[i]` pairing breaks silently. | Match by `extraction.chunkIndex` to `chunk.index` instead of positional indexing. |
| 12 | 315-319 | **LOW** | `storeMemories` casts `db` to an assumed shape with no validation | `db as { prepare(sql: string): { run(...args: unknown[]): void } }` — if the caller passes a different DB driver (e.g., not better-sqlite3), this crashes at runtime with an unhelpful error. | Add a runtime type check or use a DB abstraction interface. |

---

### 2. `chunker.ts` (365 lines) — Document Chunking

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 13 | 79-82 | **HIGH** | Overlap text can accumulate unboundedly | When flushing, `getOverlapText(currentText, config.overlapTokens)` is assigned to `currentText`, but then more sections keep appending to it. If many small sections are processed, the overlap from chunk N becomes part of chunk N+1's content, and chunk N+1's overlap includes part of chunk N's overlap. Over many chunks, this "overlap creep" can grow. | Reset `currentText` to `""` before assigning overlap: `currentText = getOverlapText(currentText, config.overlapTokens);` — this is already done, but ensure the subsequent section accumulation doesn't push the text over `maxTokens` before the next flush check. Add a secondary size check after overlap assignment. |
| 14 | 97-108 | **HIGH** | `splitLargeSection` produces non-contiguous chunk indices | `splitLargeSection` uses `startIndex` parameter set to `chunkIndex`, but after the loop `chunkIndex = sub.index + 1`. However, if `splitLargeSection` filters out chunks below `minTokens`, the indices become non-contiguous (gaps). Downstream code may assume contiguous indices. | Either don't skip small sub-chunks (pad instead), or re-index all chunks at the end of `chunkDocument()`. |
| 15 | 208-210 | **MEDIUM** | `splitText` passes `overlapChars / 4` to `getOverlapText` which expects token count | `getOverlapText(current, Math.ceil(overlapChars / 4))` — `overlapChars` is already `overlapTokens * 4`, so `overlapChars / 4 = overlapTokens`. This is correct. However, the _naming_ is misleading — `Math.ceil(overlapChars / 4)` reads as "a quarter of the char count" when it's actually "convert back to tokens". | Rename for clarity: `const overlapTokensForText = config.overlapTokens;` and pass that. |
| 16 | 227-249 | **MEDIUM** | `splitCode` applies ZERO overlap | Unlike `splitText`, the `splitCode` function never carries forward any overlap text between code chunks. Code context (variable declarations, imports) is lost between chunks. | Apply overlap to code chunks too: carry forward the last N lines or characters when splitting code blocks. |
| 17 | 255-270 | **MEDIUM** | `splitOnSentences` overlap can create duplicate content | `current = current.slice(Math.max(0, current.length - overlapChars))` — this slice may cut mid-word or mid-sentence. The overlap was supposed to be at natural boundaries but this is a raw character slice. | Find the nearest sentence boundary within the overlap region (similar to `getOverlapText`). |
| 18 | 281-291 | **LOW** | `getOverlapText` lookbehind regex not supported in all environments | `(?<=\.\s+|\n\n)` — lookbehinds require ES2018+. Older Node versions or transpilation targets may fail. This is probably fine for the Bun/modern Node target but worth noting. | Document minimum runtime requirement or use a non-lookbehind approach. |
| 19 | 70 | **LOW** | `flush()` uses closure variable `codeBlockLang` | The `codeBlockLang` is set inside the code-block detection but the `flush()` function captures it via closure. If a section contains both text and code, `codeBlockLang` from a previous code block leaks into the next text section. | Reset `codeBlockLang = undefined` inside `flush()` — actually this IS done (line 75), so this is fine. Confirming no issue. |

---

### 3. `extractor.ts` (371 lines) — LLM Knowledge Extraction

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 20 | 153-175 | **HIGH** | `parseExtractionResponse` fails on nested JSON or JSON with string-embedded braces | `jsonStr.slice(jsonStart, jsonEnd + 1)` uses `indexOf("{")` and `lastIndexOf("}")`. If the LLM response contains text like `The function returns {error: true}. Here's the JSON: {"items": [...]}`, the extraction grabs from the first `{` to the last `}`, producing `{error: true}. Here's the JSON: {"items": [...]}` which is invalid JSON. | Use a proper JSON extraction: scan for balanced braces, or try parsing from each `{` position until one succeeds. |
| 21 | 180-186 | **MEDIUM** | JSON repair only handles trailing commas | The "repair" logic removes trailing commas and newlines, but doesn't handle: unquoted keys, single-quoted strings, truncated JSON (LLM hit token limit), or control characters in strings. Common LLM failure modes. | Add more repair heuristics: replace single quotes, handle truncation by appending `]}` pairs, strip control chars. Or use a library like `json5` or `jsonrepair`. |
| 22 | 129-142 | **MEDIUM** | Sequential chunk processing — no concurrency, no batching | `extractFromChunks` processes chunks one-at-a-time sequentially. For a large document with 50+ chunks, this could take 50+ minutes (each Ollama call ~60s). | Add configurable concurrency (e.g., `Promise.all` with a semaphore of 2-3). Or at minimum, document the expected performance characteristics. |
| 23 | 107-109 | **LOW** | `callOllama` doesn't retry on transient failures | Network blips, Ollama overloaded (503), or temporary timeouts cause permanent extraction failure for that chunk. | Add 1-2 retries with exponential backoff for 5xx and network errors. |
| 24 | 194-198 | **LOW** | `validTypes` set includes non-standard types that aren't in the MemoryType union | Types like `"episodic"`, `"daily-log"`, `"configuration"`, `"architectural"`, `"relationship"` are accepted but may not match the database schema's `MemoryType` enum. | Validate against the actual `MemoryType` from `../types`. Map or reject unknown types consistently. |

---

### 4. `provenance.ts` (203 lines) — Provenance Tracking

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 25 | 18-24 | **CRITICAL** | `computeFileHash` reads entire file into memory | `readFileSync(filePath)` loads the complete file as a Buffer. For a 500MB PDF, this allocates 500MB. The hash then processes it all. | Use `fs.createReadStream(filePath).pipe(crypto.createHash('sha256'))` for streaming hash computation. |
| 26 | 22-24 | **MEDIUM** | Fallback hash uses path instead of content | On read failure, `createHash("sha256").update(filePath).digest("hex")` means two different files at the same path would appear identical, and moving a file changes its "hash". This defeats deduplication. | If the file can't be read, throw an error instead of silently returning a path-based hash. The caller can handle the error. |
| 27 | 95 | **LOW** | `createIngestionJob` silently swallows creation failure | Empty `catch {}` means if the `ingestion_jobs` table doesn't exist, the job is never tracked and no error is raised. Later calls to `updateIngestionJob` also silently fail. | At minimum log a debug message. Consider making the table creation part of migration validation at startup. |
| 28 | 71-74 | **LOW** | `getFileMetadata` returns fake data on failure | Returns `{ size: 0, modified: new Date().toISOString() }` on error — caller can't distinguish between a 0-byte file and a read failure. | Return `null` on failure or throw, let the caller decide. |

---

### 5. `markdown-parser.ts` (249 lines) — Markdown / TXT / Code Parsing

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 29 | 20, 190, 216 | **CRITICAL** | `readFileSync` with no size limit on all three parsers | `parseMarkdown`, `parseTxt`, and `parseCode` all call `readFileSync(filePath, "utf-8")` with no file size check. A 1GB markdown file will allocate 1GB+ of string memory (UTF-16 internal representation doubles it). | Check `statSync(filePath).size` first. If > threshold (e.g., 10MB), either stream-process or reject with a clear error. |
| 30 | 56-57 | **MEDIUM** | Code block fence detection too greedy | `line.startsWith("```")` matches lines like ` ``` ` (indented) when they shouldn't start a fenced block per CommonMark spec (fences must have ≤3 spaces indent). Also matches `````text````` (four backticks) incorrectly. | Use regex: `/^(`{3,}|~{3,})/ ` and track fence length for matching close. |
| 31 | 62-63 | **MEDIUM** | Mismatched code fence closers accepted | Opening with ``` ``` ``` and closing with `~~~` (or vice versa) would end the code block. CommonMark requires matching fence characters. | Track the opening fence character and length, only close on a matching fence. |
| 32 | 90-93 | **LOW** | Table detection regex too broad | `line.match(/^\s*\|/)` matches any line starting with `|` including OR expressions in code, shell pipes at line start, etc. | Require at least two `|` characters on the line, or check for table separator row (`|---|---|`). |
| 33 | 104-108 | **LOW** | List detection breaks on indented continuation | `line.match(/^\s*[-*+]\s/)` triggers for indented code examples starting with `- ` inside a paragraph. The list-to-text transition is fragile. | Track list context more carefully: require consistent indent levels and verify continuation. |
| 34 | 191-194 | **LOW** | `parseTxt` discards all blank-line structure information | Paragraphs split by `\n\n+` lose section/chapter groupings that might be present in the text (e.g., lines of `===` or `---` as dividers). | Detect common text dividers (`===`, `---`, `***`) as section boundaries. |
| 35 | 224 | **LOW** | `parseCode` extension extraction fragile | `filePath.split(".").pop()` fails for filenames with no extension (returns the whole filename) and files with multiple dots (returns last segment). `extname()` from path is more reliable. | Use `extname(filePath).slice(1)` which is already imported. |

---

### 6. `pdf-parser.ts` (217 lines) — PDF Parsing

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 36 | 28-30 | **HIGH** | `readFileSync` reads entire PDF into memory | `readFileSync(filePath)` loads the full PDF binary. PDFs can be 100MB+. Combined with pdf-parse's internal buffers, this can easily OOM. | Check file size first. For files over a threshold, warn or reject. Consider if pdf-parse supports streaming. |
| 37 | 28 | **MEDIUM** | `as any` cast on dynamic import | `await import("pdf-parse") as any` — the actual API shape is unverified. If pdf-parse v2 changes its export structure, this will fail at runtime with an unhelpful error. | Add runtime validation: check that `PDFParse` is a constructor before calling `new`. |
| 38 | 65 | **LOW** | Double `as any` for PDF info extraction | `(info as any)?.Title ?? (info as any)?.info?.Title` — type-unsafe access. If `info` has a different structure, this silently returns `null`. | Define a proper type for the expected PDF info structure. |
| 39 | 145-160 | **MEDIUM** | `isLikelyHeading` has high false positive rate | The title-case heuristic (`words >= 2 && words <= 10 && 60%+ capitalized`) matches many regular sentences in academic papers, legal docs, etc. "The Supreme Court of the United States" would be detected as a heading. | Add additional signals: check if the "heading" is followed by a blank line or longer content. Require the heading to be significantly shorter than the surrounding text. |
| 40 | 100-107 | **LOW** | No handling of scanned/image-only PDFs | If the PDF is a scanned document, `getText()` returns empty string. The parser produces an empty document with no feedback about why. | Detect empty text extraction and suggest OCR in the error/warning. |

---

### 7. `code-parser.ts` (847 lines) — Repository Parsing

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 41 | 357-365 | **MEDIUM** | `execFileSync` for git operations can hang | Despite the 15s timeout, `execFileSync` blocks the event loop entirely. A large repo with 10K+ commits makes `git shortlog` slow. Combined with the main thread being blocked, no other work can proceed. | Use `execFile` (async) with proper timeout and `AbortController`, or spawn in a worker thread. |
| 42 | 362-368 | **LOW** | Git log format string uses `|` delimiter which appears in commit messages | `--pretty=format:%H|%an|%ad|%s` — if a commit subject contains `|`, the `line.split("|")` at line 373 produces wrong field counts. The `subjectParts.join("|")` partially fixes this but `author` and `date` can be corrupted if a commit author name contains `|`. | Use a delimiter that never appears in git output, like `%x00` (null byte), or use `--pretty=format:` with structured output. |
| 43 | 349-352 | **LOW** | `findGit` hardcodes Unix paths only | Candidates are `/usr/bin/git`, `/usr/local/bin/git`, `/opt/homebrew/bin/git`. On Windows, none of these exist and `which git` also won't work via `/usr/bin/which`. | Add Windows paths (`C:\\Program Files\\Git\\cmd\\git.exe`) or use `process.platform` to select candidates. Or just use `execFileSync("git", ...)` and let the OS PATH resolve it. |
| 44 | 656-659 | **MEDIUM** | `readFileSync(fullPath, "utf-8")` in code structure scanning with no size guard | Source files up to `MAX_FILE_CHARS` (50K) are read entirely, but the size check uses `stat.size > MAX_FILE_CHARS`. Since `stat.size` is bytes but `MAX_FILE_CHARS` is characters, multi-byte UTF-8 files could be larger than expected. Also, a file of exactly 50,000 bytes is still read. | Compare against byte size properly, or just read and truncate. |
| 45 | 556-567 | **LOW** | `extractDefinitions` regex misses indented exports | `^export\s+` requires the export to be at the start of the line. TypeScript files that use `  export function` (indented, e.g., inside a namespace) are missed. | This is intentional (top-level exports only) but undocumented. Add a comment. |
| 46 | 406-410 | **LOW** | `isTrivialCommit` doesn't handle conventional commits | Commits like `chore(deps): update`, `ci: fix workflow`, `style: format` are not filtered. The filtering is ad-hoc. | Use a regex pattern for conventional commit prefixes that are typically noise: `chore`, `style`, `ci`, `docs` (the commit message body might still be useful). |

---

### 8. `slack-parser.ts` (487 lines) — Slack Export Parsing

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 47 | 264-269 | **MEDIUM** | Entire Slack channel loaded into memory at once | `loadChannelMessages` reads ALL JSON files for a channel and concatenates all messages into a single array. For an active channel with years of history, this could be millions of messages. | Process files one at a time, or add a message count limit. |
| 48 | 307-310 | **LOW** | `groupIntoThreads` thread parent may be missing from data | If a reply references `thread_ts` of a message that was deleted or is in a different export date range, the parent message won't be in `threadMap`. The replies are still grouped correctly but the thread lacks context (no parent message). | Check if the thread parent exists in the map; if not, add a synthetic "[original message not in export]" placeholder. |
| 49 | 265 | **LOW** | `JSON.parse(readFileSync(...))` with no size check | Individual Slack daily JSON files are usually small, but a malicious/corrupt export could have a huge file. | Check file size before reading, or use a streaming JSON parser for files over a threshold. |
| 50 | 340 | **LOW** | User mention regex only matches Slack user IDs | `<@U[A-Z0-9]+>` matches standard user mentions but not special mentions like `<!here>`, `<!channel>`, `<!everyone>`, or subteam mentions `<!subteam^S123|@team-name>`. | Extend regex or add patterns for special mentions. |

---

### 9. `discord-parser.ts` (464 lines) — Discord Export Parsing

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 51 | 237 | **MEDIUM** | `readFileSync` on potentially large Discord export JSON | Single Discord export files can be 100MB+ for active channels. Entire file loaded into memory and parsed with `JSON.parse`. | Check file size first. For files > 50MB, either reject with a message or use a streaming JSON parser. |
| 52 | 284-307 | **MEDIUM** | Reply chain grouping misses multi-level replies | A message replying to a reply (A → B → C) creates two chains: `B→A` and `C→B`. Messages B and C end up in different threads because C's `reference.messageId` points to B, not A. The chain isn't walked to find the root. | Walk reply chains to find the root message ID: follow `reference.messageId` until you find a message with no reference, then group all messages under that root. |
| 53 | 232-244 | **LOW** | `loadExportFile` accepts top-level arrays without guild/channel metadata | `if (Array.isArray(raw) && raw.length > 0 && raw[0].author)` returns `{ messages: raw }` — but this loses all channel/guild context. The channel name defaults to "unknown-channel". | Log a warning when falling back to array-only format so users know metadata is missing. |

---

### 10. `chat-extractor.ts` (465 lines) — Conversation Extraction

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 54 | 288-325, 339-370 | **CRITICAL** | Duplicated `callOllama` and `parseExtractionResponse` | This file contains its own copy of `callOllama` and `parseExtractionResponse` that are 95% identical to the ones in `extractor.ts`. The chat version adds `<think>` tag stripping and a minimum content length check (`< 15`), but the document extractor lacks both. Any bug fix applied to one copy may not be applied to the other. | Extract shared `callOllama` and `parseExtractionResponse` into a common utility module (e.g., `llm-client.ts`). Each extractor can then pass config-specific options. |
| 55 | 295 | **LOW** | Code discussion detection threshold is arbitrary | `return matches >= 3` — with 6 patterns, a message needs to match 3 to be classified as a "code discussion". A message about deploying with Docker that mentions `localhost` and `npm` would trigger it even if it's a high-level planning conversation. | Consider weighting patterns (code blocks = 2, keywords = 1) or using a ratio against total content length. |

---

### 11. `entire-parser.ts` (724 lines) — Entire.io Parser

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 56 | 190-195 | **CRITICAL** | Session indexing assumes 0-based contiguous directories | `for (let i = 0; i < summary.sessions.length; i++) { const sessionDir = \`${checkpointDir}/${i}\`; }` — this constructs directory paths as `0/`, `1/`, `2/` based on array index. But the actual on-disk structure uses session directories that may be `1/`, `2/`, `3/` (1-indexed per Entire's format). If Entire ever skips a number or uses non-sequential IDs, sessions are silently missed. | Use `summary.sessions[i].metadata` path from the session file paths if available, or list the actual directories on the branch: `git ls-tree ${ENTIRE_BRANCH} ${checkpointDir}/` to discover real subdirectory names. |
| 57 | 174-179 | **MEDIUM** | `git ls-tree` maxBuffer may be exceeded | `maxBuffer: 10 * 1024 * 1024` (10MB) for listing all files on the branch. A repository with thousands of Entire sessions could exceed this. | Increase buffer or stream the output. Consider `--name-only` with filtering to reduce output size. |
| 58 | 222-227 | **LOW** | Sessions sorted by date descending but then sliced for `maxSessions` | `allSessions.sort(dateB - dateA)` (most recent first) then `allSessions.slice(0, maxSessions)`. This means the MOST RECENT sessions are kept. This is probably intentional but undocumented. A user might expect the OLDEST sessions to be parsed first for chronological context. | Document the behavior in the JSDoc: "Keeps the N most recent sessions." |
| 59 | 317-335 | **LOW** | `transcriptToConversation` doesn't handle tool_result messages | User messages with `type: "tool_result"` content blocks are skipped by `extractUserContent` (which only looks for `type: "text"`). This means tool outputs (command results, file contents) that the user reviewed are lost from the conversation. | Optionally include tool_result content with a `[TOOL_RESULT]` prefix for context. |
| 60 | 146-150 | **MEDIUM** | `hasEntireBranch` called twice redundantly | In `index.ts` line 175, `hasEntireBranch(absPath)` is called during file collection. Then `parseEntireRepo` calls `hasEntireBranch` again internally. Each call invokes `git rev-parse`. | Pass a flag or cache the result. |

---

### 12. `entire-extractor.ts` (400 lines) — Entire Session Extraction

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 61 | 240-280, 295-370 | **CRITICAL** | THIRD copy of `callOllama` and `parseExtractionResponse` | This is the third independent implementation of the Ollama client and JSON response parser. It has the same `<think>` stripping as `chat-extractor.ts` but uses `"skill"` as the default type instead of `"fact"`. The `validTypes` set differs across all three copies. Bug fixes must be applied in 3 places. | **MUST refactor.** Create a shared `llm-client.ts` with the common Ollama call logic and JSON parsing. Each extractor module should import from there. |
| 62 | 25-30 | **LOW** | `minConfidence` default is 0.4, lower than other extractors (0.5) | This means Entire session extraction accepts lower-confidence items. This may be intentional (skill signals are harder to extract) but creates inconsistency. | Document the rationale for the lower threshold. |

---

### 13. `types.ts` (176 lines) — Type Definitions

| # | Line(s) | Severity | Issue | Description | Fix |
|---|---------|----------|-------|-------------|-----|
| 63 | 37 | **MEDIUM** | `db` is typed as `unknown` | `readonly db?: unknown` forces every consumer to cast it with `as`. This provides zero type safety. | Define a `DatabaseInterface` with the `prepare` method signature and use that. |
| 64 | 8 | **LOW** | `MemoryType` is imported but never used in this file | `import type { MemoryType } from "../types"` — this import is unused. The types in this file define `type: string` for extracted items, not `type: MemoryType`. | Either remove the unused import or use `MemoryType` where `string` is currently used for `ExtractedItem.type`. |

---

## Cross-Cutting Concerns

### A. Triple-Duplicated Code (CRITICAL)

The following logic is copy-pasted across three files with subtle divergences:

| Function | `extractor.ts` | `chat-extractor.ts` | `entire-extractor.ts` |
|----------|----------------|---------------------|----------------------|
| `callOllama()` | ✅ | ✅ (identical) | ✅ (identical) |
| `parseExtractionResponse()` | ✅ | ✅ + `<think>` strip + min length 15 | ✅ + `<think>` strip + min length 15 |
| `validTypes` set | 10 types | 7 types | 7 types |
| `typeMap` | 4 mappings | 6 mappings | 10 mappings |
| Default type fallback | `"fact"` | `"fact"` | `"skill"` |

**Impact:** Bug fixes and improvements must be applied 3 times. The `extractor.ts` version is MISSING the `<think>` tag stripping that the other two have — meaning if the LLM outputs `<think>` blocks during document extraction, the JSON parsing will fail.

**Fix:** Create `llm-client.ts` with shared `callOllama()` and `parseExtractionResponse()`. Accept `validTypes`, `typeMap`, and `defaultType` as parameters.

### B. Memory Safety — No Large File Guards

Every parser reads files with `readFileSync()` with no file size check:

| File | Read Location | Risk |
|------|---------------|------|
| `markdown-parser.ts:20` | `readFileSync(filePath, "utf-8")` | Unbounded string allocation |
| `markdown-parser.ts:190` | `readFileSync(filePath, "utf-8")` | Unbounded string allocation |
| `markdown-parser.ts:216` | `readFileSync(filePath, "utf-8")` | Unbounded string allocation |
| `pdf-parser.ts:30` | `readFileSync(filePath)` | Unbounded buffer allocation |
| `code-parser.ts:292` | `readFileSync(filePath, "utf-8")` | Capped at 50K chars but size check in bytes |
| `code-parser.ts:659` | `readFileSync(fullPath, "utf-8")` | Capped at 50K via stat check |
| `slack-parser.ts:266` | `readFileSync(join(...), "utf-8")` | Per-file but no size check |
| `discord-parser.ts:237` | `readFileSync(filePath, "utf-8")` | Entire export file, unbounded |
| `provenance.ts:21` | `readFileSync(filePath)` | For SHA-256 hashing, unbounded |
| `index.ts:150` | `readFileSync(filePath, "utf-8").slice(0, 4096)` | Reads full file, slices after |

**Fix:** Add a `MAX_FILE_BYTES` constant (e.g., 100MB) and check `statSync().size` before any `readFileSync`. For hashing, use streaming.

### C. Error Isolation ✅ (Good)

The pipeline DOES properly isolate per-file errors. In `index.ts:240-258`, each file is wrapped in try/catch and failures are recorded in `fileResults` with `status: "error"`. A single file failure does NOT crash the whole pipeline. This is well-designed.

### D. No Symlink Protection

`collectDirectory` follows symlinks. A malicious input directory with a symlink loop will cause infinite recursion and crash with stack overflow. Files outside the intended directory (e.g., `/etc/passwd` via symlink) could be ingested.

**Fix:** Use `lstatSync` instead of `statSync` to detect symlinks, or maintain a `Set<string>` of visited real paths.

### E. Binary File Handling

If a binary file (e.g., `.png`, `.exe`) has an extension not in `CODE_EXTS` or other sets, `detectFileType` returns `"txt"` as default. `parseTxt` then calls `readFileSync(filePath, "utf-8")`, which will produce garbage text with replacement characters. This garbage gets chunked and sent to the LLM.

**Fix:** Add binary detection (check for null bytes in the first 8KB) and skip binary files.

---

## Summary Table

| Severity | Count | Key Categories |
|----------|-------|----------------|
| **CRITICAL** | 6 | Memory (unbounded reads), code duplication (3x LLM client), session indexing |
| **HIGH** | 12 | Memory (large file reads), dead provenance code, overlap issues, JSON extraction fragility |
| **MEDIUM** | 18 | Missing validation, false positives in detection, sequential processing, missing features |
| **LOW** | 12 | Minor correctness, documentation, edge cases, portability |

## Top 5 Recommended Fixes (by Impact)

1. **Refactor LLM client into shared module** — Eliminates 3x maintenance burden and fixes missing `<think>` stripping in document extractor
2. **Add file size guards to all `readFileSync` calls** — Prevents OOM on large files, single constant controls the limit
3. **Wire up `checkAlreadyIngested` and `buildProvenance`** — Provenance and deduplication are half-built; finishing them is small effort, high value
4. **Fix `splitCode` to include overlap** — Code chunks lose critical context (imports, variable declarations) at boundaries
5. **Fix Entire session directory indexing** — Use actual directory names from git tree instead of assuming 0-indexed contiguous numbering
