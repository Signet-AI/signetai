#!/usr/bin/env python3
"""
agent memory system - persistent memory across sessions

usage:
    memory.py init                          create database and schema
    memory.py load --mode session-start     load context for session start
    memory.py load --mode prompt            load context for prompt (stdin: keywords)
    memory.py save --mode explicit          save explicit memory (stdin: content)
    memory.py save --mode auto              auto-extract from transcript (stdin: json)
    memory.py query <search>                query memories
    memory.py prune                         prune old low-value memories
    memory.py migrate                       migrate markdown files to db
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / ".agents/memory/memories.db"
DEBUG_LOG = Path.home() / ".agents/memory/debug.log"

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    who TEXT NOT NULL,
    why TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    project TEXT,
    session_id TEXT,
    importance REAL DEFAULT 0.5,
    last_accessed DATETIME,
    access_count INTEGER DEFAULT 0,
    type TEXT DEFAULT 'fact',
    tags TEXT,
    pinned INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_tags ON memories(tags);
CREATE INDEX IF NOT EXISTS idx_pinned ON memories(pinned);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content=memories,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
"""


def debug_log(msg: str):
    try:
        with open(DEBUG_LOG, "a") as f:
            f.write(f"{datetime.now().isoformat()} {msg}\n")
    except:
        pass


def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(str(DB_PATH), timeout=5.0)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("PRAGMA synchronous=NORMAL")
    return db


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = get_db()
    db.executescript(SCHEMA)
    db.executescript(FTS_SCHEMA)
    db.commit()
    db.close()
    print(f"database initialized at {DB_PATH}")


def normalize_tags(tags: str | list | None) -> str | None:
    if not tags:
        return None
    if isinstance(tags, list):
        tags = ",".join(tags)
    return ",".join(t.strip().lower() for t in tags.split(",") if t.strip())


def effective_score_sql() -> str:
    return """
    CASE
        WHEN pinned = 1 THEN 1.0
        ELSE (
            importance *
            MAX(0.1, POWER(0.95, CAST((JulianDay('now') - JulianDay(created_at)) AS INTEGER)))
        )
    END
    """


def select_with_budget(rows: list, char_budget: int = 1000) -> list:
    selected = []
    total = 0
    for row in rows:
        content_len = len(row["content"])
        if total + content_len > char_budget:
            break
        selected.append(row)
        total += content_len
    return selected


MEMORY_MD_PATH = Path.home() / ".agents/memory/MEMORY.md"
# budget: ~4096 tokens total, roughly 3.5 chars/token
# MEMORY.md gets ~10k chars, db memories get ~2k chars
MEMORY_MD_BUDGET = 10000
DB_MEMORIES_BUDGET = 2000


def load_session_start(project: str | None = None):
    output = ["[memory active | /remember | /recall]"]

    # prepend MEMORY.md if it exists
    if MEMORY_MD_PATH.exists():
        current_md = MEMORY_MD_PATH.read_text().strip()
        if current_md:
            # truncate if over budget
            if len(current_md) > MEMORY_MD_BUDGET:
                current_md = current_md[:MEMORY_MD_BUDGET] + "\n[truncated]"
            output.append("")
            output.append(current_md)

    # then add db memories
    db = get_db()
    score_sql = effective_score_sql()

    query = f"""
    SELECT id, content, type, tags, ({score_sql}) as eff_score
    FROM memories
    WHERE (({score_sql}) > 0.2 OR pinned = 1)
      AND (project = ? OR project = 'global' OR project IS NULL)
    ORDER BY
        CASE WHEN project = ? THEN 0 ELSE 1 END,
        eff_score DESC
    LIMIT 30
    """

    rows = db.execute(query, (project, project)).fetchall()
    selected = select_with_budget(rows, char_budget=DB_MEMORIES_BUDGET)

    if selected:
        ids = [r["id"] for r in selected]
        placeholders = ",".join("?" * len(ids))
        db.execute(f"""
            UPDATE memories
            SET last_accessed = datetime('now'), access_count = access_count + 1
            WHERE id IN ({placeholders})
        """, ids)
        db.commit()

        output.append("")
        for row in selected:
            tags_str = f" [{row['tags']}]" if row["tags"] else ""
            output.append(f"- {row['content']}{tags_str}")

    db.close()
    print("\n".join(output))


def load_prompt(project: str | None = None):
    stdin_data = sys.stdin.read().strip()
    if not stdin_data:
        return

    try:
        data = json.loads(stdin_data)
        keywords = data.get("user_prompt", "")
    except json.JSONDecodeError:
        keywords = stdin_data

    if not keywords or len(keywords) < 3:
        return

    db = get_db()

    words = re.findall(r'\b\w{3,}\b', keywords.lower())
    if not words:
        return

    fts_query = " OR ".join(words[:10])

    try:
        rows = db.execute("""
            SELECT m.id, m.content, m.tags, m.importance, m.pinned
            FROM memories_fts fts
            JOIN memories m ON fts.rowid = m.id
            WHERE memories_fts MATCH ?
              AND (m.project = ? OR m.project = 'global' OR m.project IS NULL)
            ORDER BY rank
            LIMIT 15
        """, (fts_query, project)).fetchall()
    except sqlite3.OperationalError:
        db.close()
        return

    score_sql = effective_score_sql()
    filtered = []
    for row in rows:
        eff = db.execute(f"SELECT ({score_sql}) as s FROM memories WHERE id = ?",
                        (row["id"],)).fetchone()["s"]
        if eff > 0.3 or row["pinned"]:
            filtered.append(dict(row) | {"eff_score": eff})

    filtered.sort(key=lambda x: x["eff_score"], reverse=True)
    selected = select_with_budget(filtered, char_budget=500)

    if selected:
        ids = [r["id"] for r in selected]
        placeholders = ",".join("?" * len(ids))
        db.execute(f"""
            UPDATE memories
            SET last_accessed = datetime('now'), access_count = access_count + 1
            WHERE id IN ({placeholders})
        """, ids)
        db.commit()

        output = ["[relevant memories]"]
        for row in selected:
            output.append(f"- {row['content']}")
        print("\n".join(output))

    db.close()


def save_explicit(who: str = "claude-code", project: str | None = None, content: str | None = None):
    if content:
        stdin_data = content.strip()
    else:
        stdin_data = sys.stdin.read().strip()

    if not stdin_data:
        print("error: no content provided", file=sys.stderr)
        sys.exit(1)

    content = stdin_data
    importance = 0.8
    pinned = 0
    why = "explicit"
    tags = None
    mem_type = "fact"

    if content.startswith("critical:"):
        content = content[9:].strip()
        importance = 1.0
        pinned = 1
        why = "explicit-critical"

    tag_match = re.match(r'^\[([^\]]+)\]:\s*(.+)$', content, re.DOTALL)
    if tag_match:
        tags = normalize_tags(tag_match.group(1))
        content = tag_match.group(2).strip()

    type_hints = {
        "prefer": "preference",
        "decided": "decision",
        "learned": "learning",
        "issue": "issue",
        "bug": "issue",
    }
    content_lower = content.lower()
    for hint, t in type_hints.items():
        if hint in content_lower:
            mem_type = t
            break

    db = get_db()
    now = datetime.now().isoformat()
    memory_id = str(uuid.uuid4())
    cursor = db.execute("""
        INSERT INTO memories (id, content, who, why, project, importance, type, tags, pinned, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (memory_id, content, who, why, project, importance, mem_type, tags, pinned, now, who))
    db.commit()
    db.close()

    # Generate and store embedding
    try:
        from embeddings import embed
        from vector_store import insert_vector
        
        vector, _ = embed(content)
        insert_vector(str(memory_id), vector)
        print(f"saved + embedded: {content[:50]}...")
    except Exception as e:
        debug_log(f"embedding failed for memory {memory_id}: {e}")
        print(f"saved (no embedding): {content[:50]}...")


def save_auto():
    stdin_data = sys.stdin.read().strip()
    if not stdin_data:
        debug_log("auto-save: no stdin data")
        return

    try:
        data = json.loads(stdin_data)
    except json.JSONDecodeError:
        debug_log(f"auto-save: invalid json: {stdin_data[:100]}")
        return

    transcript_path = data.get("transcript_path")
    session_id = data.get("session_id")
    cwd = data.get("cwd")
    reason = data.get("reason")

    if reason == "clear":
        debug_log("auto-save: session cleared, skipping")
        return

    if not transcript_path:
        debug_log("auto-save: no transcript path")
        return

    transcript_path = Path(transcript_path).expanduser()
    if not transcript_path.exists():
        debug_log(f"auto-save: transcript not found: {transcript_path}")
        return

    content = transcript_path.read_text()
    if len(content) < 500:
        debug_log("auto-save: transcript too short")
        return

    memories = extract_memories_local(content)
    if not memories:
        debug_log("auto-save: no memories extracted")
        return

    db = get_db()
    saved = 0
    for mem in memories:
        if mem.get("importance", 0) < 0.4:
            continue

        if is_duplicate(db, mem["content"]):
            continue

        now = datetime.now().isoformat()
        memory_id = str(uuid.uuid4())
        db.execute("""
            INSERT INTO memories (id, content, who, why, project, session_id, importance, type, tags, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            memory_id,
            mem["content"],
            "claude-code",
            f"auto-{mem.get('type', 'fact')}",
            cwd,
            session_id,
            mem.get("importance", 0.5),
            mem.get("type", "fact"),
            normalize_tags(mem.get("tags")),
            now,
            "claude-code"
        ))
        saved += 1

    db.commit()
    db.close()
    debug_log(f"auto-save: saved {saved} memories")


def extract_memories_local(content: str) -> list:
    """
    extract memories using local model via ollama.
    falls back to empty list if ollama not available.
    """
    import subprocess

    prompt = f"""/no_think
Extract ONLY significant, contextual facts from this coding session transcript.

STRICT RULES:
1. DO NOT save: user messages verbatim, assistant responses, temporary states, routine operations
2. DO save: user preferences, technical decisions with reasoning, solved issues with solutions, project-specific configs
3. Each memory MUST have enough context to be useful standalone (not "the user wants X" but "nicholai prefers X because Y")
4. Maximum 5 memories per session. If nothing significant, return []
5. importance scale: 0.3-0.5 (most auto-extracted should be low)

Return ONLY a JSON array:
[{{"content": "...", "type": "fact|decision|preference|issue|learning", "tags": "tag1,tag2", "importance": 0.3-0.5}}]

Transcript:
{content[:8000]}
"""

    try:
        result = subprocess.run(
            ["ollama", "run", "qwen3:4b", prompt],
            capture_output=True,
            text=True,
            timeout=45
        )

        output = result.stdout.strip()
        json_match = re.search(r'\[[\s\S]*?\]', output)
        if json_match:
            memories = json.loads(json_match.group())
            # enforce importance cap for auto-extracted
            for mem in memories:
                if mem.get("importance", 0.5) > 0.5:
                    mem["importance"] = 0.4
            return memories
        return []
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError) as e:
        debug_log(f"extract_memories_local: {e}")
        return []


def is_duplicate(db: sqlite3.Connection, content: str) -> bool:
    try:
        words = re.findall(r'\b\w{4,}\b', content.lower())[:5]
        if not words:
            return False

        fts_query = " AND ".join(words)
        rows = db.execute("""
            SELECT content FROM memories_fts
            WHERE memories_fts MATCH ?
            LIMIT 5
        """, (fts_query,)).fetchall()

        for row in rows:
            existing = row["content"].lower()
            if content.lower() in existing or existing in content.lower():
                return True
            overlap = len(set(content.lower().split()) & set(existing.split()))
            if overlap > len(content.split()) * 0.7:
                return True
        return False
    except sqlite3.OperationalError:
        return False


def query_memories(search: str, limit: int = 20):
    """Query memories using hybrid search (vector + BM25)"""
    try:
        from hybrid_search import search_with_fallback
        
        results = search_with_fallback(search, limit)
        
        if not results:
            print("no memories found")
            return
        
        for r in results:
            tags = f" [{r['tags']}]" if r['tags'] else ""
            pinned = " [pinned]" if r['pinned'] else ""
            source = "hybrid" if r['vector_score'] > 0 and r['bm25_score'] > 0 else (
                "vector" if r['vector_score'] > 0 else "keyword"
            )
            
            print(f"[{r['hybrid_score']:.2f}|{source}] {r['content']}{tags}{pinned}")
            print(f"       type: {r['type']} | who: {r['who']} | project: {r['project'] or 'global'}")
            print()
    
    except ImportError:
        # Fallback to old FTS-only search if hybrid search not available
        query_memories_fts_only(search, limit)


def query_memories_fts_only(search: str, limit: int = 20):
    """Fallback FTS-only query (old implementation)"""
    db = get_db()
    score_sql = effective_score_sql()

    results = []

    try:
        fts_rows = db.execute("""
            SELECT m.*, rank as fts_rank
            FROM memories_fts fts
            JOIN memories m ON fts.rowid = m.id
            WHERE memories_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (search, limit)).fetchall()
        results.extend(fts_rows)
    except sqlite3.OperationalError:
        pass

    tag_rows = db.execute("""
        SELECT * FROM memories
        WHERE LOWER(tags) LIKE ?
        ORDER BY importance DESC
        LIMIT ?
    """, (f"%{search.lower()}%", limit)).fetchall()

    seen_ids = {r["id"] for r in results}
    for row in tag_rows:
        if row["id"] not in seen_ids:
            results.append(row)

    if not results:
        print("no memories found")
        db.close()
        return

    scored = []
    for row in results:
        eff = db.execute(f"SELECT ({score_sql}) as s FROM memories WHERE id = ?",
                        (row["id"],)).fetchone()["s"]
        scored.append(dict(row) | {"eff_score": eff})

    scored.sort(key=lambda x: x["eff_score"], reverse=True)

    for row in scored[:limit]:
        tags = f" [{row['tags']}]" if row["tags"] else ""
        pinned = " [pinned]" if row["pinned"] else ""
        print(f"[{row['eff_score']:.2f}] {row['content']}{tags}{pinned}")
        print(f"       type: {row['type']} | who: {row['who']} | project: {row['project'] or 'global'}")
        print()

    db.close()


def prune_memories():
    db = get_db()

    result = db.execute("""
        DELETE FROM memories
        WHERE why LIKE 'auto-%'
          AND pinned = 0
          AND importance < 0.3
          AND created_at < datetime('now', '-60 days')
          AND access_count = 0
    """)

    deleted = result.rowcount
    db.commit()
    db.close()

    print(f"pruned {deleted} old low-value memories")


def migrate_markdown():
    """migrate existing markdown memory files to the database"""
    memory_dir = Path.home() / "clawd/memory"
    if not memory_dir.exists():
        print("no memory directory found at ~/clawd/memory/")
        return

    db = get_db()
    migrated = 0

    for md_file in memory_dir.glob("*.md"):
        content = md_file.read_text()
        filename = md_file.stem

        if re.match(r'^\d{4}-\d{2}-\d{2}$', filename):
            memories = parse_dated_memory(content, filename)
        else:
            memories = parse_topical_memory(content, filename)

        for mem in memories:
            if is_duplicate(db, mem["content"]):
                continue

            now = datetime.now().isoformat()
            memory_id = str(uuid.uuid4())
            db.execute("""
                INSERT INTO memories (id, content, who, why, project, importance, type, tags, updated_at, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                memory_id,
                mem["content"],
                "claude-code",
                "migrated",
                mem.get("project"),
                mem.get("importance", 0.6),
                mem.get("type", "fact"),
                normalize_tags(mem.get("tags")),
                now,
                "migration"
            ))
            migrated += 1

    db.commit()
    db.close()
    print(f"migrated {migrated} memories from markdown files")


def parse_dated_memory(content: str, date: str) -> list:
    """parse dated memory files (2026-01-20.md style)"""
    memories = []

    lines = content.split("\n")
    current_section = None

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("="):
            continue

        if stripped.endswith("---------") or (stripped == "---" and i > 0):
            prev_line = lines[i - 1].strip() if i > 0 else None
            if prev_line and not prev_line.startswith("-"):
                current_section = prev_line
            continue

        if stripped.startswith("##"):
            current_section = stripped.lstrip("#").strip()
            continue

        if stripped.startswith("-") and not stripped.endswith("---"):
            fact = stripped.lstrip("- ").strip()
            if len(fact) > 10:
                mem_type = "fact"
                importance = 0.6
                tags = []

                if current_section:
                    tags.append(current_section.lower().replace(" ", "-"))

                if "prefer" in fact.lower():
                    mem_type = "preference"
                    importance = 0.8
                elif "decided" in fact.lower() or "chose" in fact.lower():
                    mem_type = "decision"
                    importance = 0.7
                elif "issue" in fact.lower() or "bug" in fact.lower() or "error" in fact.lower():
                    mem_type = "issue"
                elif "learned" in fact.lower() or "takeaway" in fact.lower():
                    mem_type = "learning"

                memories.append({
                    "content": fact,
                    "type": mem_type,
                    "importance": importance,
                    "tags": ",".join(tags) if tags else None
                })

    return memories


def parse_topical_memory(content: str, topic: str) -> list:
    """parse topical memory files (package-preferences.md style)"""
    memories = []

    lines = content.split("\n")
    for line in lines:
        line = line.strip()
        if not line or line.startswith("=") or line.startswith("---------"):
            continue

        if line.startswith("-") or line.startswith("1.") or line.startswith("2.") or line.startswith("3."):
            fact = re.sub(r'^[\d\.\-\*]+\s*', '', line).strip()
            if len(fact) > 10:
                memories.append({
                    "content": fact,
                    "type": "preference" if "prefer" in topic.lower() else "fact",
                    "importance": 0.7,
                    "tags": topic.lower().replace("-", ",").replace("_", ",")
                })

    return memories


def main():
    parser = argparse.ArgumentParser(description="agent memory system")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init", help="initialize database")

    load_parser = subparsers.add_parser("load", help="load memories")
    load_parser.add_argument("--mode", choices=["session-start", "prompt"], required=True)
    load_parser.add_argument("--project", help="project path")

    save_parser = subparsers.add_parser("save", help="save memory")
    save_parser.add_argument("--mode", choices=["explicit", "auto"], required=True)
    save_parser.add_argument("--who", default="claude-code")
    save_parser.add_argument("--project", help="project path")
    save_parser.add_argument("--content", help="content to save (alternative to stdin)")

    query_parser = subparsers.add_parser("query", help="query memories")
    query_parser.add_argument("search", help="search term")
    query_parser.add_argument("--limit", type=int, default=20)

    subparsers.add_parser("prune", help="prune old memories")
    subparsers.add_parser("migrate", help="migrate markdown files")

    args = parser.parse_args()

    if args.command == "init":
        init_db()
    elif args.command == "load":
        project = args.project or os.getcwd()
        if args.mode == "session-start":
            load_session_start(project)
        else:
            load_prompt(project)
    elif args.command == "save":
        if args.mode == "explicit":
            save_explicit(args.who, args.project or os.getcwd(), args.content)
        else:
            save_auto()
    elif args.command == "query":
        query_memories(args.search, args.limit)
    elif args.command == "prune":
        prune_memories()
    elif args.command == "migrate":
        migrate_markdown()


if __name__ == "__main__":
    main()
