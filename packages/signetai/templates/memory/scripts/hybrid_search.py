#!/usr/bin/env python3
"""
Hybrid search for Signet memory system.
Combines vector similarity (zvec) with BM25 keyword search (SQLite FTS5).

Formula: final_score = (α × vector_similarity) + ((1-α) × bm25_score)
Default α = 0.7 (70% vector, 30% keyword)

Usage:
    hybrid_search.py search <query> [--limit N] [--alpha A]
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Optional

import yaml

# Local imports
from embeddings import embed, load_config as load_embed_config
from vector_store import search_vectors, init_collection

CONFIG_PATH = Path.home() / ".agents/config.yaml"
DB_PATH = Path.home() / ".agents/memory/memories.db"


def load_config() -> dict:
    """Load configuration from config.yaml"""
    if not CONFIG_PATH.exists():
        return {
            "search": {"alpha": 0.7, "top_k": 20, "min_score": 0.3},
        }
    
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def get_db() -> sqlite3.Connection:
    """Get database connection"""
    db = sqlite3.connect(str(DB_PATH), timeout=5.0)
    db.row_factory = sqlite3.Row
    return db


def normalize_scores(scores: list[float]) -> list[float]:
    """Min-max normalize scores to [0, 1]"""
    if not scores:
        return []
    
    min_s = min(scores)
    max_s = max(scores)
    
    if max_s == min_s:
        return [1.0] * len(scores)
    
    return [(s - min_s) / (max_s - min_s) for s in scores]


def effective_score_sql() -> str:
    """SQL expression for effective memory score (importance * decay)"""
    return """
    CASE
        WHEN pinned = 1 THEN 1.0
        ELSE (
            importance *
            MAX(0.1, POWER(0.95, CAST((JulianDay('now') - JulianDay(created_at)) AS INTEGER)))
        )
    END
    """


def vector_search(query: str, k: int = 20, config: Optional[dict] = None) -> dict[str, float]:
    """
    Search using vector similarity.
    Returns {memory_id: normalized_score}
    """
    if config is None:
        config = load_config()
    
    try:
        # Generate query embedding
        query_vector, _ = embed(query, config)
        
        # Search zvec
        results = search_vectors(query_vector, k, config)
        
        if not results:
            return {}
        
        # zvec returns cosine similarity (higher = more similar)
        # Normalize to [0, 1]
        scores = [r["score"] for r in results]
        normalized = normalize_scores(scores)
        
        return {r["id"]: norm for r, norm in zip(results, normalized)}
    
    except Exception as e:
        print(f"Vector search error: {e}", file=sys.stderr)
        return {}


def bm25_search(query: str, k: int = 20) -> dict[str, float]:
    """
    Search using BM25 (FTS5).
    Returns {memory_id: normalized_score}
    """
    db = get_db()
    
    try:
        # FTS5 returns negative rank (lower = better match)
        rows = db.execute("""
            SELECT m.id, -fts.rank as score
            FROM memories_fts fts
            JOIN memories m ON fts.rowid = m.id
            WHERE memories_fts MATCH ?
            ORDER BY fts.rank
            LIMIT ?
        """, (query, k)).fetchall()
        
        if not rows:
            db.close()
            return {}
        
        # Normalize scores
        scores = [r["score"] for r in rows]
        normalized = normalize_scores(scores)
        
        result = {str(r["id"]): norm for r, norm in zip(rows, normalized)}
        db.close()
        return result
    
    except sqlite3.OperationalError as e:
        db.close()
        print(f"BM25 search error: {e}", file=sys.stderr)
        return {}


def hybrid_search(
    query: str, 
    limit: int = 20, 
    alpha: float = 0.7,
    config: Optional[dict] = None
) -> list[dict]:
    """
    Perform hybrid search combining vector and BM25.
    
    Args:
        query: Search query text
        limit: Maximum results to return
        alpha: Weight for vector similarity (1-alpha for BM25)
        config: Optional config dict
    
    Returns:
        List of {id, content, score, vector_score, bm25_score, ...}
    """
    if config is None:
        config = load_config()
    
    search_config = config.get("search", {})
    top_k = search_config.get("top_k", 20)
    min_score = search_config.get("min_score", 0.3)
    
    # Get scores from both sources
    vector_scores = vector_search(query, top_k, config)
    bm25_scores = bm25_search(query, top_k)
    
    # Collect all candidate IDs
    all_ids = set(vector_scores.keys()) | set(bm25_scores.keys())
    
    if not all_ids:
        return []
    
    # Calculate hybrid scores
    candidates = []
    for mem_id in all_ids:
        v_score = vector_scores.get(mem_id, 0.0)
        b_score = bm25_scores.get(mem_id, 0.0)
        
        # Hybrid formula
        hybrid_score = (alpha * v_score) + ((1 - alpha) * b_score)
        
        candidates.append({
            "id": mem_id,
            "hybrid_score": hybrid_score,
            "vector_score": v_score,
            "bm25_score": b_score,
        })
    
    # Sort by hybrid score
    candidates.sort(key=lambda x: x["hybrid_score"], reverse=True)
    
    # Filter by min score and limit
    candidates = [c for c in candidates if c["hybrid_score"] >= min_score][:limit]
    
    if not candidates:
        return []
    
    # Fetch full memory data
    db = get_db()
    score_sql = effective_score_sql()
    
    results = []
    for cand in candidates:
        row = db.execute(f"""
            SELECT *, ({score_sql}) as eff_score
            FROM memories
            WHERE id = ?
        """, (cand["id"],)).fetchone()
        
        if row:
            results.append({
                "id": row["id"],
                "content": row["content"],
                "type": row["type"],
                "tags": row["tags"],
                "who": row["who"],
                "project": row["project"],
                "pinned": bool(row["pinned"]),
                "importance": row["importance"],
                "eff_score": row["eff_score"],
                "hybrid_score": cand["hybrid_score"],
                "vector_score": cand["vector_score"],
                "bm25_score": cand["bm25_score"],
            })
    
    # Update access stats
    if results:
        ids = [r["id"] for r in results]
        placeholders = ",".join("?" * len(ids))
        db.execute(f"""
            UPDATE memories
            SET last_accessed = datetime('now'), access_count = access_count + 1
            WHERE id IN ({placeholders})
        """, ids)
        db.commit()
    
    db.close()
    return results


def search_with_fallback(
    query: str,
    limit: int = 20,
    alpha: float = 0.7,
    config: Optional[dict] = None
) -> list[dict]:
    """
    Search with graceful fallback.
    If vector search fails, fall back to BM25 only.
    """
    try:
        results = hybrid_search(query, limit, alpha, config)
        if results:
            return results
    except Exception as e:
        print(f"Hybrid search failed, falling back to BM25: {e}", file=sys.stderr)
    
    # Fallback to BM25 only
    bm25_scores = bm25_search(query, limit)
    
    if not bm25_scores:
        return []
    
    db = get_db()
    score_sql = effective_score_sql()
    
    results = []
    for mem_id, score in sorted(bm25_scores.items(), key=lambda x: x[1], reverse=True):
        row = db.execute(f"""
            SELECT *, ({score_sql}) as eff_score
            FROM memories
            WHERE id = ?
        """, (mem_id,)).fetchone()
        
        if row:
            results.append({
                "id": row["id"],
                "content": row["content"],
                "type": row["type"],
                "tags": row["tags"],
                "who": row["who"],
                "project": row["project"],
                "pinned": bool(row["pinned"]),
                "importance": row["importance"],
                "eff_score": row["eff_score"],
                "hybrid_score": score,
                "vector_score": 0.0,
                "bm25_score": score,
            })
    
    db.close()
    return results[:limit]


def main():
    parser = argparse.ArgumentParser(description="Signet hybrid search")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--limit", "-n", type=int, default=20, help="Max results")
    parser.add_argument("--alpha", "-a", type=float, default=0.7, help="Vector weight")
    parser.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    
    args = parser.parse_args()
    
    results = search_with_fallback(args.query, args.limit, args.alpha)
    
    if args.json:
        print(json.dumps(results, indent=2))
    else:
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
            print(f"       scores: vec={r['vector_score']:.2f} bm25={r['bm25_score']:.2f} eff={r['eff_score']:.2f}")
            print()


if __name__ == "__main__":
    main()
