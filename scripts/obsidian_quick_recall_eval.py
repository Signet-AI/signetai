#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import math
import os
import re
import sqlite3
import statistics
import sys
import time
import socket
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
GEN_MODEL = os.environ.get("RECALL_EVAL_GEN_MODEL", "gemma4:e2b")
EMBED_MODEL = os.environ.get("RECALL_EVAL_EMBED_MODEL", "nomic-embed-text:latest")
CACHE_DIR = Path(".tmp/obsidian-recall-eval")
CACHE_DIR.mkdir(parents=True, exist_ok=True)
GEN_CACHE = CACHE_DIR / "generated_queries.json"
EMBED_CACHE = CACHE_DIR / "embeddings.json"

TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-/]{1,}")
FRONTMATTER_RE = re.compile(r"^---\n.*?\n---\n", re.S)
CODE_FENCE_RE = re.compile(r"```.*?```", re.S)
WIKI_LINK_RE = re.compile(r"\[\[(.*?)\]\]")
INLINE_LINK_RE = re.compile(r"\[(.*?)\]\([^)]*\)")
HEADING_RE = re.compile(r"^#+\s+", re.M)
MULTISPACE_RE = re.compile(r"\s+")
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
    "i", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to",
    "was", "what", "when", "where", "which", "who", "why", "with", "would",
}

EXPLORATORY_QUERY_BUCKETS: dict[str, list[str]] = {
    "soft_human": [
        "thank you",
        "i appreciate you",
        "im sorry",
        "im proud of you",
    ],
    "reflective": [
        "what did we celebrate",
        "what were we worried about",
        "what was stressing me out",
        "what was i excited about",
    ],
}


def safe_fts_terms(text: str) -> list[str]:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", " ", text)
    return [t.lower() for t in cleaned.split() if t]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return {}


def save_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), "utf-8")


def strip_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = FRONTMATTER_RE.sub("", text)
    text = CODE_FENCE_RE.sub(" ", text)
    text = WIKI_LINK_RE.sub(lambda m: m.group(1).split("|")[0], text)
    text = INLINE_LINK_RE.sub(lambda m: m.group(1), text)
    text = HEADING_RE.sub("", text)
    text = text.replace("`", " ")
    text = text.replace("#", " ")
    text = MULTISPACE_RE.sub(" ", text)
    return text.strip()


def title_from_path(path: Path) -> str:
    stem = path.stem
    stem = stem.replace("-", " ").replace("_", " ")
    return stem.strip()


def top_group(rel: Path) -> str:
    return rel.parts[0] if rel.parts else "root"


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text)]


def fts_query(text: str) -> str:
    toks = []
    for tok in safe_fts_terms(text):
        if len(tok) < 3:
            continue
        toks.append(f'{tok}*')
    return " OR ".join(dict.fromkeys(toks)) or '"' + text.replace('"', ' ') + '"'


def norm(v: list[float]) -> list[float]:
    mag = math.sqrt(sum(x * x for x in v))
    if mag == 0:
        return v
    return [x / mag for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return max(0.0, sum(x * y for x, y in zip(a, b)))


def http_json(path: str, body: dict[str, Any]) -> dict[str, Any]:
    last_err: Exception | None = None
    for attempt in range(4):
        req = urllib.request.Request(
            f"{OLLAMA_URL.rstrip('/')}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (TimeoutError, socket.timeout, urllib.error.URLError) as err:
            last_err = err
            time.sleep(min(2 ** attempt, 8))
    raise RuntimeError(f"request failed after retries for {path}: {last_err}")


def ollama_generate(prompt: str) -> str:
    data = http_json(
        "/api/generate",
        {
            "model": GEN_MODEL,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.2},
        },
    )
    return str(data.get("response", "")).strip()


def ollama_embed(text: str) -> list[float]:
    data = http_json(
        "/api/embeddings",
        {"model": EMBED_MODEL, "prompt": text},
    )
    emb = data.get("embedding") or []
    if not isinstance(emb, list):
        return []
    return [float(x) for x in emb]


@dataclass
class Note:
    id: str
    path: str
    corpus: str
    group: str
    title: str
    text: str
    mtime: float


@dataclass
class QueryPack:
    index_hints: list[str]
    eval_query: str


@dataclass
class Chunk:
    id: str
    note_id: str
    text: str


def select_notes(vault: Path, per_group: int | None, all_groups: bool) -> list[Note]:
    groups = ["dev", "fleeting", "literature", "people", "permanent", "raw"]
    grouped: dict[str, list[Path]] = defaultdict(list)
    for p in vault.rglob("*.md"):
        rel = p.relative_to(vault)
        grp = top_group(rel)
        if "attachments" in rel.parts or p.name in {"AGENTS.md", "CLAUDE.md"}:
            continue
        if not all_groups and grp not in groups:
            continue
        raw = p.read_text("utf-8", errors="ignore")
        text = strip_markdown(raw)
        if len(text) < 250 or len(text) > 12000:
            continue
        if p.name.lower().startswith("readme"):
            continue
        grouped[grp].append(p)

    picked: list[Note] = []
    ordered_groups = sorted(grouped) if all_groups else groups
    for grp in ordered_groups:
        candidates = sorted(grouped.get(grp, []), key=lambda p: sha(str(p)))
        limit = len(candidates) if per_group is None else per_group
        for p in candidates[:limit]:
            rel = p.relative_to(vault)
            text = strip_markdown(p.read_text("utf-8", errors="ignore"))
            title = title_from_path(rel)
            picked.append(
                Note(
                    id=sha(str(rel))[:16],
                    path=str(rel),
                    corpus="curated",
                    group=grp,
                    title=title,
                    text=text,
                    mtime=p.stat().st_mtime,
                )
            )
    return picked


def parse_iso_mtime(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def title_from_content(text: str, fallback: str) -> str:
    first = text.splitlines()[0].strip()
    if first:
        return first[:80]
    return fallback


def select_dirty_notes(db_path: Path, limit: int) -> list[Note]:
    if limit <= 0 or not db_path.exists():
        return []

    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            """
            SELECT
                id,
                content,
                COALESCE(tags, ''),
                COALESCE(who, ''),
                COALESCE(project, ''),
                COALESCE(source_type, ''),
                COALESCE(created_at, '')
            FROM memories
            WHERE is_deleted = 0
              AND length(content) BETWEEN 250 AND 12000
              AND (
                who IN ('openclaw-memory', 'memorybench')
                OR tags LIKE '%memory-log%'
                OR source_type = 'chunk'
                OR project = ''
              )
            ORDER BY id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        conn.close()

    picked: list[Note] = []
    for memory_id, content, tags, who, project, source_type, created_at in rows:
        text = strip_markdown(str(content))
        fallback = str(who or source_type or "dirty memory").strip() or "dirty memory"
        group_parts = [str(who).strip(), str(source_type).strip(), "dirty"]
        group = ":".join(part for part in group_parts if part)[:80]
        picked.append(
            Note(
                id=str(memory_id),
                path=f"memory/{memory_id}",
                corpus="dirty",
                group=group,
                title=title_from_content(text, fallback),
                text=text,
                mtime=parse_iso_mtime(str(created_at) if created_at else None),
            )
        )
    return picked


def build_query_prompt(note: Note) -> str:
    excerpt = note.text[:1800]
    return f'''Return strict JSON with this shape:
{{"index_hints":["...","..."],"eval_query":"..."}}

Task:
You are creating retrieval eval data for a personal knowledge note.
- index_hints: 2 short natural-language queries/cues this note should be indexed under.
- eval_query: 1 held-out user query that this note should answer.

Rules:
- The eval_query should be natural and semantically related, but not just the title rewritten.
- Avoid copying long exact phrases from the note.
- Keep each query under 14 words.
- Do not mention file paths.
- Return JSON only.

Title: {note.title}
Path: {note.path}
Content excerpt:
"""
{excerpt}
"""'''


def build_eval_query_prompt(note: Note, hints: list[str]) -> str:
    excerpt = note.text[:1600]
    return f'''Return strict JSON with this shape:
{{"eval_query":"..."}}

Task:
Create 1 held-out user retrieval query for this note.

Rules:
- It should be something a human might naturally ask later.
- It must be semantically related to the note.
- Do not just restate the title.
- Avoid copying the indexed hints too closely.
- Keep it under 14 words.
- Return JSON only.

Title: {note.title}
Existing indexed hints: {json.dumps(hints, ensure_ascii=False)}
Content excerpt:
"""
{excerpt}
"""'''


def get_query_pack(note: Note, gen_cache: dict[str, Any]) -> QueryPack:
    key = f"{note.corpus}:{note.id}"
    cached = gen_cache.get(key)
    if isinstance(cached, dict):
        hints = [str(x).strip() for x in cached.get("index_hints", []) if str(x).strip()]
        eval_query = str(cached.get("eval_query", "")).strip()
        if len(hints) >= 2 and eval_query:
            return QueryPack(index_hints=hints[:2], eval_query=eval_query)

    raw = ollama_generate(build_query_prompt(note))
    try:
        parsed = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"failed to parse query pack for {note.path}: {e}\nRAW: {raw}")
    hints = [str(x).strip() for x in parsed.get("index_hints", []) if str(x).strip()][:2]
    eval_query = str(parsed.get("eval_query", "")).strip()
    if not eval_query:
        raw_eval = ollama_generate(build_eval_query_prompt(note, hints))
        try:
            eval_parsed = json.loads(raw_eval)
        except Exception as e:
            raise RuntimeError(f"failed to parse fallback eval query for {note.path}: {e}\nRAW: {raw_eval}")
        eval_query = str(eval_parsed.get("eval_query", "")).strip()
    if not eval_query:
        raise RuntimeError(f"invalid query pack for {note.path}: {parsed}")
    if len(hints) < 2:
        fallback_hints: list[str] = []
        if eval_query:
            fallback_hints.append(eval_query)
        if note.title:
            fallback_hints.append(note.title)
        if note.path:
            fallback_hints.append(title_from_path(Path(note.path)))
        for candidate in fallback_hints:
            cleaned = str(candidate).strip()
            if cleaned and cleaned not in hints:
                hints.append(cleaned)
            if len(hints) >= 2:
                break
    if len(hints) < 2:
        raise RuntimeError(f"invalid query pack for {note.path}: {parsed}")
    pack = QueryPack(index_hints=hints, eval_query=eval_query)
    gen_cache[key] = asdict(pack)
    return pack


def get_embedding(text: str, embed_cache: dict[str, Any]) -> list[float]:
    key = sha(text)
    cached = embed_cache.get(key)
    if isinstance(cached, list) and cached:
        return [float(x) for x in cached]
    vec = norm(ollama_embed(text))
    embed_cache[key] = vec
    return vec


def build_db(notes: list[Note], query_packs: dict[str, QueryPack]) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT, title TEXT, body TEXT, mtime REAL)")
    db.execute("CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, path, body)")
    db.execute("CREATE TABLE hints (note_id TEXT, hint TEXT)")
    db.execute("CREATE VIRTUAL TABLE hints_fts USING fts5(note_id UNINDEXED, hint)")
    for note in notes:
        db.execute("INSERT INTO notes VALUES (?, ?, ?, ?, ?)", (note.id, note.path, note.title, note.text, note.mtime))
        db.execute("INSERT INTO notes_fts VALUES (?, ?, ?, ?)", (note.id, note.title, note.path, note.text))
        pack = query_packs[note.id]
        for hint in pack.index_hints:
            db.execute("INSERT INTO hints VALUES (?, ?)", (note.id, hint))
            db.execute("INSERT INTO hints_fts VALUES (?, ?)", (note.id, hint))
    db.commit()
    return db


def chunk_text(text: str, size: int = 900, overlap: int = 180) -> list[str]:
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= len(text):
            break
        start = max(0, end - overlap)
    return chunks


def build_chunks(notes: list[Note]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for note in notes:
        for idx, piece in enumerate(chunk_text(note.text), start=1):
            chunks.append(
                Chunk(
                    id=f"{note.id}:{idx}",
                    note_id=note.id,
                    text=f"{note.title}\n{note.path}\n\n{piece}",
                )
            )
    return chunks


def build_chunk_db(chunks: list[Chunk]) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE chunks (id TEXT PRIMARY KEY, note_id TEXT, body TEXT)")
    db.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, note_id UNINDEXED, body)")
    for chunk in chunks:
        db.execute("INSERT INTO chunks VALUES (?, ?, ?)", (chunk.id, chunk.note_id, chunk.text))
        db.execute("INSERT INTO chunks_fts VALUES (?, ?, ?)", (chunk.id, chunk.note_id, chunk.text))
    db.commit()
    return db


def build_vocabulary(notes: list[Note]) -> set[str]:
    vocab: set[str] = set()
    for note in notes:
        vocab.update(tokenize(note.title))
        vocab.update(tokenize(note.path))
        vocab.update(tokenize(note.text[:4000]))
    return vocab


def lexical_content_scores(db: sqlite3.Connection, query: str) -> dict[str, float]:
    q = fts_query(query)
    rows = db.execute(
        "SELECT id, bm25(notes_fts, 3.0, 1.5, 1.0) AS raw_score FROM notes_fts WHERE notes_fts MATCH ? ORDER BY raw_score LIMIT 50",
        (q,),
    ).fetchall()
    if not rows:
        return {}
    vals = [abs(float(r[1])) for r in rows]
    mx = max(vals) or 1.0
    return {str(r[0]): abs(float(r[1])) / mx for r in rows}


def lexical_hint_scores(db: sqlite3.Connection, query: str) -> dict[str, float]:
    q = fts_query(query)
    rows = db.execute(
        "SELECT note_id, bm25(hints_fts) AS raw_score FROM hints_fts WHERE hints_fts MATCH ? ORDER BY raw_score LIMIT 50",
        (q,),
    ).fetchall()
    if not rows:
        return {}
    vals = [abs(float(r[1])) for r in rows]
    mx = max(vals) or 1.0
    per_note: dict[str, float] = {}
    for note_id, raw in rows:
        score = abs(float(raw)) / mx
        note_id = str(note_id)
        if score > per_note.get(note_id, 0.0):
            per_note[note_id] = score
    return per_note


def lexical_chunk_scores(db: sqlite3.Connection, query: str) -> dict[str, float]:
    q = fts_query(query)
    rows = db.execute(
        "SELECT note_id, bm25(chunks_fts, 1.0) AS raw_score "
        "FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY raw_score LIMIT 120",
        (q,),
    ).fetchall()
    if not rows:
        return {}
    vals = [abs(float(r[1])) for r in rows]
    mx = max(vals) or 1.0
    per_note: dict[str, float] = {}
    for note_id, raw in rows:
        score = abs(float(raw)) / mx
        note_id = str(note_id)
        if score > per_note.get(note_id, 0.0):
            per_note[note_id] = score
    return per_note


def byterover_terms(query: str) -> list[str]:
    words = safe_fts_terms(query)
    filtered = [w for w in words if w not in STOPWORDS]
    return filtered or words


def fuzzy_expand(term: str, vocab: set[str]) -> list[str]:
    if term in vocab:
        return [term]
    if len(term) < 4:
        return [term]
    close = difflib.get_close_matches(term, vocab, n=3, cutoff=0.84)
    return [term, *close] if close else [term]


def byterover_query(text: str, vocab: set[str], combine: str) -> str:
    clauses = []
    for term in byterover_terms(text):
        expanded = fuzzy_expand(term, vocab)
        bits = []
        for item in dict.fromkeys(expanded):
            for safe in safe_fts_terms(item):
                if len(safe) >= 2:
                    bits.append(f"{safe}*")
        if not bits:
            continue
        clause = " OR ".join(bits)
        clauses.append(f"({clause})" if len(bits) > 1 else clause)
    if not clauses:
        return fts_query(text)
    joiner = f" {combine} "
    return joiner.join(clauses)


def recency_boost(now: float, mtime: float) -> float:
    days_since = max(0.0, (now - mtime) / 86400.0)
    return 1.0 / (1.0 + (days_since / 365.0))


def byterover_style_scores(db: sqlite3.Connection, query: str, vocab: set[str]) -> dict[str, float]:
    now = time.time()

    def run(search_query: str) -> list[tuple[str, float, float]]:
        return db.execute(
            "SELECT n.id, bm25(notes_fts, 3.0, 1.5, 1.0) AS raw_score, n.mtime "
            "FROM notes_fts JOIN notes n ON n.id = notes_fts.id "
            "WHERE notes_fts MATCH ? ORDER BY raw_score LIMIT 50",
            (search_query,),
        ).fetchall()

    rows = run(byterover_query(query, vocab, "AND"))
    if not rows:
        rows = run(byterover_query(query, vocab, "OR"))
    if not rows:
        return {}

    scores: dict[str, float] = {}
    for note_id, raw, mtime in rows:
        bm25 = abs(float(raw))
        lexical = bm25 / (1.0 + bm25)
        score = lexical * 0.85 + recency_boost(now, float(mtime)) * 0.15
        scores[str(note_id)] = score
    return scores


def vector_doc_scores(query_vec: list[float], note_vecs: dict[str, list[float]]) -> dict[str, float]:
    return {note_id: cosine(query_vec, vec) for note_id, vec in note_vecs.items()}


def vector_hint_scores(query_vec: list[float], hint_vecs: dict[str, list[list[float]]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for note_id, vecs in hint_vecs.items():
        out[note_id] = max((cosine(query_vec, v) for v in vecs), default=0.0)
    return out


def vector_chunk_scores(query_vec: list[float], chunk_vecs: dict[str, list[list[float]]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for note_id, vecs in chunk_vecs.items():
        out[note_id] = max((cosine(query_vec, v) for v in vecs), default=0.0)
    return out


def rank_docs(scores: dict[str, float]) -> list[tuple[str, float]]:
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


def combine_hybrid(content_lex: dict[str, float], content_vec: dict[str, float], alpha: float = 0.7) -> dict[str, float]:
    out: dict[str, float] = {}
    for note_id in set(content_lex) | set(content_vec):
        lex = content_lex.get(note_id, 0.0)
        vec = content_vec.get(note_id, 0.0)
        if lex > 0 and vec > 0:
            out[note_id] = alpha * vec + (1 - alpha) * lex
        else:
            out[note_id] = max(lex, vec)
    return out


def combine_current_hint_fts(content_lex: dict[str, float], hint_lex: dict[str, float]) -> dict[str, float]:
    out: dict[str, float] = {}
    for note_id in set(content_lex) | set(hint_lex):
        content = content_lex.get(note_id, 0.0)
        hint = hint_lex.get(note_id, 0.0)
        blended = content * 0.7 + hint * 0.3 if content > 0 else hint
        out[note_id] = max(content, blended)
    return out


def combine_hint_semantic(content_vec: dict[str, float], hint_vec: dict[str, float]) -> dict[str, float]:
    out: dict[str, float] = {}
    for note_id in set(content_vec) | set(hint_vec):
        content = content_vec.get(note_id, 0.0)
        hint = hint_vec.get(note_id, 0.0)
        blended = content * 0.7 + hint * 0.3 if content > 0 else hint
        out[note_id] = max(content, blended)
    return out


def evaluate_strategy(
    name: str,
    queries: list[tuple[Note, str]],
    scorer,
    notes_by_id: dict[str, Note],
) -> dict[str, Any]:
    ranks = []
    misses = []
    total = len(queries)
    for idx, (note, query) in enumerate(queries, start=1):
        if idx == 1 or idx % 25 == 0 or idx == total:
            print(f"[{name} {idx}/{total}] scoring retrieval")
        ranked = rank_docs(scorer(query))
        rank = next((i + 1 for i, (note_id, _) in enumerate(ranked) if note_id == note.id), None)
        if rank is None:
            rank = 999
        ranks.append(rank)
        if rank > 5:
            misses.append(
                {
                    "target": note.path,
                    "group": note.group,
                    "query": query,
                    "rank": rank,
                    "top3": [
                        {"path": notes_by_id[note_id].path, "score": round(score, 4)}
                        for note_id, score in ranked[:3]
                    ],
                }
            )
    total = len(ranks)
    hit1 = sum(1 for r in ranks if r <= 1) / total
    hit3 = sum(1 for r in ranks if r <= 3) / total
    hit5 = sum(1 for r in ranks if r <= 5) / total
    mrr = sum(1 / r for r in ranks if r < 999) / total
    return {
        "strategy": name,
        "queries": total,
        "hit@1": round(hit1, 4),
        "hit@3": round(hit3, 4),
        "hit@5": round(hit5, 4),
        "mrr": round(mrr, 4),
        "median_rank": statistics.median(ranks),
        "misses": misses[:5],
    }


def exploratory_results(
    scorer,
    notes_by_id: dict[str, Note],
) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for bucket, queries in EXPLORATORY_QUERY_BUCKETS.items():
        print(f"[exploratory:{bucket}] scoring {len(queries)} queries")
        rows: list[dict[str, Any]] = []
        for query in queries:
            ranked = rank_docs(scorer(query))
            rows.append(
                {
                    "query": query,
                    "top3": [
                        {
                            "path": notes_by_id[note_id].path,
                            "title": notes_by_id[note_id].title,
                            "group": notes_by_id[note_id].group,
                            "score": round(score, 4),
                        }
                        for note_id, score in ranked[:3]
                    ],
                }
            )
        out[bucket] = rows
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Quick isolated recall eval against a read-only Obsidian vault sample")
    ap.add_argument("--vault", default="/mnt/work/obsidian-vault")
    ap.add_argument("--dirty-db", default="/home/nicholai/.agents/memory/memories.db")
    ap.add_argument("--dirty-count", type=int, default=0)
    ap.add_argument("--mixed-curated", type=int, default=0)
    ap.add_argument("--mixed-dirty", type=int, default=0)
    ap.add_argument("--per-group", type=int, default=4)
    ap.add_argument("--all", action="store_true", help="Use the full eligible vault instead of a per-group sample")
    ap.add_argument("--out", default=str(CACHE_DIR / "latest-results.json"))
    args = ap.parse_args()

    vault = Path(args.vault)
    if not vault.exists():
        print(f"vault not found: {vault}", file=sys.stderr)
        return 1

    gen_cache = load_json(GEN_CACHE)
    embed_cache = load_json(EMBED_CACHE)

    curated_notes = select_notes(vault, None if args.all else args.per_group, args.all)
    if not curated_notes:
        print("no notes selected", file=sys.stderr)
        return 1
    dirty_notes = select_dirty_notes(Path(args.dirty_db), args.dirty_count)
    corpora: dict[str, list[Note]] = {"curated": curated_notes}
    if dirty_notes:
        corpora["dirty"] = dirty_notes
    if args.mixed_curated > 0 or args.mixed_dirty > 0:
        mixed: list[Note] = []
        mixed.extend(curated_notes[: args.mixed_curated or len(curated_notes)])
        mixed.extend(dirty_notes[: args.mixed_dirty or len(dirty_notes)])
        if mixed:
            corpora["mixed"] = mixed

    print("corpora:")
    for corpus_name, notes in corpora.items():
        print(f"- {corpus_name}: {len(notes)} notes")
        by_group: dict[str, int] = defaultdict(int)
        for note in notes:
            by_group[note.group] += 1
        print(f"  groups: {dict(sorted(by_group.items()))}")

    corpus_results: dict[str, Any] = {}
    for corpus_name, notes in corpora.items():
        notes_by_id = {n.id: n for n in notes}
        vocab = build_vocabulary(notes)

        query_packs: dict[str, QueryPack] = {}
        for idx, note in enumerate(notes, start=1):
            if idx == 1 or idx % 25 == 0 or idx == len(notes):
                print(f"[{corpus_name} {idx}/{len(notes)}] generating query packs")
            query_packs[note.id] = get_query_pack(note, gen_cache)
            save_json(GEN_CACHE, gen_cache)

        note_vecs: dict[str, list[float]] = {}
        hint_vecs: dict[str, list[list[float]]] = {}
        chunk_vecs: dict[str, list[list[float]]] = {}
        queries: list[tuple[Note, str]] = []
        for idx, note in enumerate(notes, start=1):
            text = f"{note.title}\n{note.path}\n\n{note.text[:4000]}"
            if idx == 1 or idx % 25 == 0 or idx == len(notes):
                print(f"[{corpus_name} {idx}/{len(notes)}] embedding notes")
            note_vecs[note.id] = get_embedding(text, embed_cache)
            hint_vecs[note.id] = [get_embedding(h, embed_cache) for h in query_packs[note.id].index_hints]
            queries.append((note, query_packs[note.id].eval_query))
            save_json(EMBED_CACHE, embed_cache)

        db = build_db(notes, query_packs)
        chunks = build_chunks(notes)
        chunk_db = build_chunk_db(chunks)
        chunks_by_note: dict[str, list[Chunk]] = defaultdict(list)
        for chunk in chunks:
            chunks_by_note[chunk.note_id].append(chunk)
        for idx, note in enumerate(notes, start=1):
            if idx == 1 or idx % 25 == 0 or idx == len(notes):
                print(f"[{corpus_name} {idx}/{len(notes)}] embedding chunks")
            chunk_vecs[note.id] = [get_embedding(chunk.text, embed_cache) for chunk in chunks_by_note[note.id]]
            save_json(EMBED_CACHE, embed_cache)

        def scorer_byterover(query: str) -> dict[str, float]:
            return byterover_style_scores(db, query, vocab)

        def scorer_signet_hybrid(query: str) -> dict[str, float]:
            qv = get_embedding(query, embed_cache)
            return combine_hybrid(lexical_content_scores(db, query), vector_doc_scores(qv, note_vecs))

        def scorer_signet_hint_fts(query: str) -> dict[str, float]:
            qv = get_embedding(query, embed_cache)
            lex = combine_current_hint_fts(lexical_content_scores(db, query), lexical_hint_scores(db, query))
            return combine_hybrid(lex, vector_doc_scores(qv, note_vecs))

        def scorer_signet_hint_hybrid(query: str) -> dict[str, float]:
            qv = get_embedding(query, embed_cache)
            lex = combine_current_hint_fts(lexical_content_scores(db, query), lexical_hint_scores(db, query))
            sem = combine_hint_semantic(vector_doc_scores(qv, note_vecs), vector_hint_scores(qv, hint_vecs))
            return combine_hybrid(lex, sem)

        def scorer_plain_chunked_rag(query: str) -> dict[str, float]:
            qv = get_embedding(query, embed_cache)
            return combine_hybrid(lexical_chunk_scores(chunk_db, query), vector_chunk_scores(qv, chunk_vecs))

        scorers = {
            "byterover_style_search": scorer_byterover,
            "signet_content_hybrid": scorer_signet_hybrid,
            "plain_chunked_rag_hybrid": scorer_plain_chunked_rag,
            "signet_current_plus_hint_fts": scorer_signet_hint_fts,
            "signet_plus_hint_hybrid": scorer_signet_hint_hybrid,
        }
        strategies = [
            evaluate_strategy(name, queries, scorer, notes_by_id)
            for name, scorer in scorers.items()
        ]
        save_json(EMBED_CACHE, embed_cache)
        exploratory = {
            name: exploratory_results(scorer, notes_by_id)
            for name, scorer in scorers.items()
        }
        save_json(EMBED_CACHE, embed_cache)

        corpus_results[corpus_name] = {
            "selected_notes": [asdict(n) | asdict(query_packs[n.id]) for n in notes],
            "strategies": strategies,
            "exploratory_queries": exploratory,
        }

    out = {
        "vault": str(vault),
        "dirty_db": str(args.dirty_db),
        "corpora": corpus_results,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), "utf-8")

    print("\nresults")
    for corpus_name, corpus in corpus_results.items():
        print(f"\n[{corpus_name}]")
        for row in corpus["strategies"]:
            print(
                f"- {row['strategy']}: hit@1={row['hit@1']:.3f} hit@3={row['hit@3']:.3f} hit@5={row['hit@5']:.3f} mrr={row['mrr']:.3f} median_rank={row['median_rank']}"
            )
    print(f"\nfull report: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
