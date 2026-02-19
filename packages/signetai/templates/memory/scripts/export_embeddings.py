#!/usr/bin/env python3
"""Export memory embeddings for dashboard visualization.

Supports both modern Signet databases (embeddings in SQLite) and older
template installs that only have memory rows.
"""

import argparse
import json
import sqlite3
import struct
import sys
from pathlib import Path
from typing import Any

AGENTS_DIR = Path.home() / ".agents"
DB_PATH = AGENTS_DIR / "memory" / "memories.db"

DEFAULT_LIMIT = 600
MIN_LIMIT = 1
MAX_LIMIT = 5000


def clamp_limit(value: int) -> int:
    return max(MIN_LIMIT, min(MAX_LIMIT, value))


def build_result(
    embeddings: list[dict[str, Any]],
    total: int,
    limit: int,
    offset: int,
    error: str | None = None,
) -> dict[str, Any]:
    return {
        "embeddings": embeddings,
        "count": len(embeddings),
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": offset + limit < total,
        "error": error,
    }


def parse_tags(raw: Any) -> list[str]:
    if raw is None:
        return []

    if isinstance(raw, list):
        tags = [str(tag).strip() for tag in raw if str(tag).strip()]
        return tags

    if not isinstance(raw, str):
        return []

    text = raw.strip()
    if not text:
        return []

    if text.startswith("[") and text.endswith("]"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [
                    tag.strip()
                    for tag in parsed
                    if isinstance(tag, str) and tag.strip()
                ]
        except json.JSONDecodeError:
            pass

    return [tag.strip() for tag in text.split(",") if tag.strip()]


def to_vector(blob: Any, dimensions: Any) -> list[float]:
    if blob is None:
        return []

    if isinstance(blob, memoryview):
        raw = blob.tobytes()
    elif isinstance(blob, (bytes, bytearray)):
        raw = bytes(blob)
    else:
        return []

    if len(raw) < 4:
        return []

    usable_length = len(raw) - (len(raw) % 4)
    floats = [entry[0] for entry in struct.iter_unpack("<f", raw[:usable_length])]

    if isinstance(dimensions, int) and 0 < dimensions < len(floats):
        return floats[:dimensions]
    return floats


def table_exists(db: sqlite3.Connection, table_name: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def base_embedding_row(row: sqlite3.Row) -> dict[str, Any]:
    memory_id = str(row["id"])
    content = row["content"] if isinstance(row["content"], str) else ""
    importance = (
        row["importance"] if isinstance(row["importance"], (int, float)) else 0.5
    )

    return {
        "id": memory_id,
        "content": content,
        "text": content,
        "who": row["who"] or "unknown",
        "importance": float(importance),
        "type": row["type"] if isinstance(row["type"], str) else None,
        "tags": parse_tags(row["tags"]),
        "sourceType": "memory",
        "sourceId": memory_id,
        "createdAt": row["created_at"],
    }


def export_embeddings(limit: int, offset: int) -> dict[str, Any]:
    if not DB_PATH.exists():
        return build_result([], 0, limit, offset, "No database found")

    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    try:
        total_row = db.execute("SELECT COUNT(*) AS count FROM memories").fetchone()
        total = int(total_row["count"]) if total_row else 0

        rows = db.execute(
            """
            SELECT id, content, who, importance, type, tags, created_at
            FROM memories
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()

        embeddings = [base_embedding_row(row) for row in rows]
        return build_result(embeddings, total, limit, offset)
    finally:
        db.close()


def export_with_vectors_from_table(
    db: sqlite3.Connection,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    total_row = db.execute(
        """
        SELECT COUNT(*) AS count
        FROM embeddings e
        INNER JOIN memories m ON m.id = e.source_id
        WHERE e.source_type = 'memory'
        """
    ).fetchone()
    total = int(total_row["count"]) if total_row else 0

    rows = db.execute(
        """
        SELECT
            m.id,
            m.content,
            m.who,
            m.importance,
            m.type,
            m.tags,
            m.created_at,
            e.vector,
            e.dimensions,
            e.source_type,
            e.source_id
        FROM embeddings e
        INNER JOIN memories m ON m.id = e.source_id
        WHERE e.source_type = 'memory'
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()

    embeddings: list[dict[str, Any]] = []
    for row in rows:
        item = base_embedding_row(row)
        item["sourceType"] = row["source_type"] or "memory"
        item["sourceId"] = row["source_id"] or item["id"]
        item["vector"] = to_vector(row["vector"], row["dimensions"])
        embeddings.append(item)

    return build_result(embeddings, total, limit, offset)


def export_with_vectors_via_embed(
    db: sqlite3.Connection,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    sys.path.insert(0, str(AGENTS_DIR / "memory" / "scripts"))

    try:
        from embeddings import embed
    except Exception as exc:
        return build_result(
            [], 0, limit, offset, f"Failed to load embeddings.py: {exc}"
        )

    total_row = db.execute("SELECT COUNT(*) AS count FROM memories").fetchone()
    total = int(total_row["count"]) if total_row else 0

    rows = db.execute(
        """
        SELECT id, content, who, importance, type, tags, created_at
        FROM memories
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()

    embeddings: list[dict[str, Any]] = []
    for row in rows:
        content = row["content"] if isinstance(row["content"], str) else ""
        if not content:
            continue
        try:
            vector, _ = embed(content)
        except Exception:
            continue

        item = base_embedding_row(row)
        item["vector"] = vector
        embeddings.append(item)

    return build_result(embeddings, total, limit, offset)


def export_with_vectors(limit: int, offset: int) -> dict[str, Any]:
    if not DB_PATH.exists():
        return build_result([], 0, limit, offset, "No database found")

    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    try:
        if table_exists(db, "embeddings"):
            return export_with_vectors_from_table(db, limit, offset)
        return export_with_vectors_via_embed(db, limit, offset)
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Export embeddings for dashboard")
    parser.add_argument(
        "--with-vectors", action="store_true", help="Include vector arrays"
    )
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Page size")
    parser.add_argument("--offset", type=int, default=0, help="Page offset")
    args = parser.parse_args()

    limit = clamp_limit(args.limit)
    offset = max(0, args.offset)

    if args.with_vectors:
        result = export_with_vectors(limit, offset)
    else:
        result = export_embeddings(limit, offset)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
