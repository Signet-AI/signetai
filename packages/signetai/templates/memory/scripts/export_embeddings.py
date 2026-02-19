#!/usr/bin/env python3
"""Export memory embeddings for dashboard visualization."""

import argparse
import json
import sqlite3
import struct
from pathlib import Path

AGENTS_DIR = Path.home() / ".agents"
DB_PATH = AGENTS_DIR / "memory" / "memories.db"


def blob_to_vector(blob: bytes, dimensions: int) -> list[float]:
    expected_len = dimensions * 4
    if len(blob) < expected_len:
        return []
    unpacked = struct.unpack(f"<{dimensions}f", blob[:expected_len])
    return [float(v) for v in unpacked]


def export_embeddings(limit: int, with_vectors: bool) -> dict:
    if not DB_PATH.exists():
        return {"error": "No database found", "embeddings": []}

    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    try:
        rows = db.execute(
            """
            SELECT
              e.source_id AS id,
              m.content,
              m.who,
              m.importance,
              m.tags,
              m.created_at,
              e.vector,
              e.dimensions
            FROM embeddings e
            JOIN memories m ON m.id = e.source_id
            WHERE e.source_type = 'memory'
            ORDER BY m.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except sqlite3.Error as exc:
        db.close()
        return {"error": f"Failed to query embeddings: {exc}", "embeddings": []}

    embeddings = []
    for row in rows:
        item = {
            "id": str(row["id"]),
            "text": row["content"][:200],
            "content": row["content"],
            "who": row["who"] or "unknown",
            "importance": row["importance"] or 0.5,
            "tags": row["tags"],
            "createdAt": row["created_at"],
        }

        if with_vectors:
            vector_blob = row["vector"]
            dimensions = int(row["dimensions"] or 0)
            if isinstance(vector_blob, bytes) and dimensions > 0:
                vector = blob_to_vector(vector_blob, dimensions)
                if vector:
                    item["vector"] = vector

        embeddings.append(item)

    db.close()
    return {"embeddings": embeddings, "count": len(embeddings)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--with-vectors", action="store_true")
    parser.add_argument("--limit", type=int, default=1000)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    safe_limit = max(1, min(args.limit, 5000))
    result = export_embeddings(limit=safe_limit, with_vectors=args.with_vectors)
    print(json.dumps(result))
