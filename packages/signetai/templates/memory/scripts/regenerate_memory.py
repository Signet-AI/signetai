#!/usr/bin/env python3
"""
regenerate MEMORY.md from transcripts and database
runs daily via systemd timer

usage:
    regenerate_current.py              regenerate ~/.agents/memory/MEMORY.md
    regenerate_current.py --dry-run    preview without writing
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / ".agents/memory/memories.db"
CURRENT_MD_PATH = Path.home() / ".agents/memory/MEMORY.md"
TRANSCRIPTS_DIRS = [
    Path.home() / ".claude/transcripts",       # old location
    Path.home() / ".claude/projects",          # new location (project-based)
]
CLAUDE_MD_PATH = Path.home() / ".claude/CLAUDE.md"
DEBUG_LOG = Path.home() / ".agents/memory/debug.log"

TRANSCRIPT_WINDOW_DAYS = 14
MODELS = ["glm-4.7-flash", "qwen3:4b"]  # fallback chain


def debug_log(msg: str):
    try:
        with open(DEBUG_LOG, "a") as f:
            f.write(f"{datetime.now().isoformat()} [regenerate] {msg}\n")
    except:
        pass


def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(str(DB_PATH), timeout=5.0)
    db.row_factory = sqlite3.Row
    return db


def get_recent_transcripts() -> list[dict]:
    """get transcripts from the last N days, sorted by recency"""
    cutoff = datetime.now() - timedelta(days=TRANSCRIPT_WINDOW_DAYS)
    transcripts = []

    # collect jsonl files from all transcript locations
    jsonl_files = []
    for transcript_dir in TRANSCRIPTS_DIRS:
        if not transcript_dir.exists():
            continue
        # old location: direct files
        jsonl_files.extend(transcript_dir.glob("*.jsonl"))
        # new location: project subdirs (but not subagents)
        for project_dir in transcript_dir.iterdir():
            if project_dir.is_dir() and not project_dir.name.startswith('.'):
                for f in project_dir.glob("*.jsonl"):
                    # skip subagent transcripts
                    if "subagents" not in str(f):
                        jsonl_files.append(f)

    for jsonl_file in jsonl_files:
        mtime = datetime.fromtimestamp(jsonl_file.stat().st_mtime)
        if mtime < cutoff:
            continue

        try:
            messages = []
            with open(jsonl_file) as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                        entry_type = entry.get("type")

                        # handle both old format (content directly) and new format (message.content)
                        if entry_type == "user":
                            content = entry.get("content") or ""
                            # new format: content is in message.content
                            if not content and "message" in entry:
                                content = entry["message"].get("content", "")
                            if content and isinstance(content, str):
                                messages.append(f"USER: {content[:500]}")

                        elif entry_type == "assistant":
                            content = entry.get("content") or ""
                            # new format: content is in message.content (may be list of blocks)
                            if not content and "message" in entry:
                                msg_content = entry["message"].get("content", [])
                                if isinstance(msg_content, list):
                                    # extract text blocks
                                    texts = [b.get("text", "") for b in msg_content if b.get("type") == "text"]
                                    content = " ".join(texts)
                                elif isinstance(msg_content, str):
                                    content = msg_content
                            if content and isinstance(content, str) and len(content) > 20:
                                messages.append(f"ASSISTANT: {content[:500]}")

                    except json.JSONDecodeError:
                        continue

            if messages:
                transcripts.append({
                    "file": jsonl_file.name,
                    "mtime": mtime,
                    "messages": messages
                })
        except Exception as e:
            debug_log(f"error reading {jsonl_file}: {e}")

    # sort by recency, most recent first
    transcripts.sort(key=lambda x: x["mtime"], reverse=True)
    return transcripts


def get_high_value_memories() -> list[dict]:
    """get pinned and high-importance memories from db"""
    if not DB_PATH.exists():
        return []

    db = get_db()
    rows = db.execute("""
        SELECT content, type, tags, importance
        FROM memories
        WHERE pinned = 1 OR importance >= 0.7
        ORDER BY importance DESC, created_at DESC
        LIMIT 50
    """).fetchall()
    db.close()

    return [dict(row) for row in rows]


def get_claude_md_context() -> str:
    """get relevant sections from CLAUDE.md for context"""
    if not CLAUDE_MD_PATH.exists():
        return ""

    content = CLAUDE_MD_PATH.read_text()
    sections = []

    # extract key sections that define who nicholai is
    section_patterns = [
        (r'your role\n-+\n(.*?)(?=\n[a-z])', "Role"),
        (r'speaking and mannerisms\n-+\n(.*?)(?=\n[a-z])', "Communication style"),
        (r'coding standards\n-+\n(.*?)(?=\n[a-z])', "Coding standards"),
        (r'nicholai specific info\n-+\n(.*?)(?=\n[a-z]|\Z)', "Projects"),
    ]

    for pattern, label in section_patterns:
        match = re.search(pattern, content, re.DOTALL | re.IGNORECASE)
        if match:
            section_text = match.group(1).strip()[:1500]
            sections.append(f"[{label}]\n{section_text}")

    return "\n\n".join(sections)[:5000]


def build_synthesis_prompt(transcripts: list, memories: list, claude_md: str) -> str:
    """build the prompt for synthesizing MEMORY.md"""

    # summarize recent transcripts
    transcript_summary = []
    for i, t in enumerate(transcripts[:15]):  # more sessions
        msgs = t["messages"][:15]  # more messages per session
        transcript_summary.append(f"[{t['mtime'].strftime('%Y-%m-%d')}]\n" +
                                  "\n".join(msgs))

    transcript_text = "\n\n".join(transcript_summary)[:8000]  # bigger budget

    # format memories - these are the PRIMARY source
    memories_text = "\n".join([
        f"- [{m['type']}] {m['content']}" + (f" [{m['tags']}]" if m['tags'] else "")
        for m in memories
    ])[:4000]

    # /no_think suppresses qwen3's thinking output
    return f"""/no_think
You are synthesizing a memory document about Nicholai for AI assistants.

This document is WORKING MEMORY - focus on what's CURRENT and ACTIONABLE.
Personal bio and preferences are already in CLAUDE.md - don't repeat them here.

FOCUS ON:
1. Active projects from the last few days (from transcripts)
2. Project priorities and status
3. Technical context needed for current work
4. Critical rules and warnings

SORT PROJECTS BY:
1. Permanence (long-term projects > one-off tasks)
2. Importance (core projects > side experiments)
3. Recency (actively worked on > dormant)

=== PROJECT CONTEXT (from CLAUDE.MD) ===
{claude_md}

=== STANDING RULES & FACTS ===
{memories_text}

=== RECENT ACTIVITY (last 2 weeks) ===
{transcript_text}

---

Write MEMORY.md as a working memory document. Focus on ACTIVE WORK, not biography.
Target: 3000-5000 characters.

FORMAT:

# Current Context

[1-2 sentences: what's the current focus area?]

## Active Projects

[List projects actively being worked on, sorted by importance/permanence. For each: name, location, current status/blockers, what needs to happen next. Be specific about file paths and technical details.]

## Recent Work

[What was done in the last few sessions? What decisions were made? What problems were solved or encountered?]

## Technical Notes

[Current technical context: what tools/models are in use, what's configured, what needs attention. Only include what's relevant to active work.]

## Rules & Warnings

[Bullet list of critical rules that must not be forgotten. Keep it short - only the important stuff.]

---

Write the document now. Output ONLY the markdown, no preamble."""


def strip_markdown(text: str) -> str:
    """remove markdown formatting for cleaner output"""
    # remove ### headers, keep text
    text = re.sub(r'^###\s+', '', text, flags=re.MULTILINE)
    # remove ## headers, keep text
    text = re.sub(r'^##\s+', '', text, flags=re.MULTILINE)
    # remove # headers, keep text
    text = re.sub(r'^#\s+', '', text, flags=re.MULTILINE)
    # remove bold **text**
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    # remove italic *text*
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    # remove bullet points, keep text
    text = re.sub(r'^\s*\*\s+', '- ', text, flags=re.MULTILINE)
    # clean up excessive blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def synthesize_current_md(transcripts: list, memories: list, claude_md: str) -> str:
    """synthesize MEMORY.md using available models (with fallback)"""

    prompt = build_synthesis_prompt(transcripts, memories, claude_md)

    for model in MODELS:
        debug_log(f"trying model: {model}")
        try:
            result = subprocess.run(
                ["ollama", "run", model, prompt],
                capture_output=True,
                text=True,
                timeout=180
            )

            if result.returncode != 0:
                debug_log(f"{model} failed: {result.stderr[:200]}")
                continue

            output = result.stdout.strip()

            # clean up any thinking tags/blocks if present
            output = re.sub(r'<think>.*?</think>', '', output, flags=re.DOTALL)
            output = re.sub(r'```thinking.*?```', '', output, flags=re.DOTALL)

            # find ALL occurrences of main headers and take the LAST complete one
            # (model often outputs thinking first, then actual content)
            all_matches = list(re.finditer(r'# (Current Context|Nicholai)\n', output, re.IGNORECASE))
            if all_matches:
                # take the last occurrence
                last_match = all_matches[-1]
                output = output[last_match.start():].strip()

                # remove trailing reasoning/meta text (often starts with "Let me" or similar)
                reasoning_patterns = [
                    r'\n\nLet me .*$',
                    r'\n\nLet\'s .*$',
                    r'\n\nI\'ll .*$',
                    r'\n\nNote:.*$',
                    r'\n\nBut note:.*$',
                    r'\n\nAlternatively.*$',
                    r'\n\n\[truncated\].*$',
                    r'\n\nThinking\.\.\..*$',
                ]
                for pattern in reasoning_patterns:
                    output = re.sub(pattern, '', output, flags=re.DOTALL)

            output = output.strip()

            if output.startswith("# Current") or output.startswith("# Nicholai") or output.startswith("# nicholai") or output.startswith("Current Context"):
                # check it's not just a template (has actual content, not [brackets])
                if "[1-2 sentence" not in output and "[List projects" not in output:
                    # strip markdown formatting
                    output = strip_markdown(output)
                    # truncate to 8000 chars if needed
                    if len(output) > 8000:
                        output = output[:8000].rsplit('\n', 1)[0] + "\n\n[truncated]"
                    debug_log(f"success with {model} ({len(output)} chars)")
                    return output
                else:
                    debug_log(f"{model} returned template instead of content")

            debug_log(f"{model} unexpected format: {output[:200]}")

        except subprocess.TimeoutExpired:
            debug_log(f"{model} timed out")
        except Exception as e:
            debug_log(f"{model} error: {e}")

    return ""


def main():
    parser = argparse.ArgumentParser(description="regenerate MEMORY.md")
    parser.add_argument("--dry-run", action="store_true", help="preview without writing")
    args = parser.parse_args()

    debug_log("starting regeneration")

    # gather inputs
    transcripts = get_recent_transcripts()
    memories = get_high_value_memories()
    claude_md = get_claude_md_context()

    debug_log(f"found {len(transcripts)} transcripts, {len(memories)} memories")

    if not transcripts and not memories:
        debug_log("no data to synthesize from")
        print("no transcripts or memories found, skipping regeneration")
        return

    # synthesize
    result = synthesize_current_md(transcripts, memories, claude_md)

    if not result:
        debug_log("synthesis produced no output")
        print("synthesis failed, keeping existing MEMORY.md")
        return

    # add generation timestamp
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    result = f"<!-- generated {timestamp} -->\n\n{result}"

    if args.dry_run:
        print("=== DRY RUN ===")
        print(result)
        print(f"\n=== {len(result)} characters ===")
    else:
        CURRENT_MD_PATH.parent.mkdir(parents=True, exist_ok=True)
        CURRENT_MD_PATH.write_text(result)
        debug_log(f"wrote {len(result)} chars to MEMORY.md")
        print(f"regenerated MEMORY.md ({len(result)} chars)")


if __name__ == "__main__":
    main()
