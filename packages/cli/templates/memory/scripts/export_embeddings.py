#!/usr/bin/env python3
"""Export embeddings for visualization."""

import json
import sqlite3
import sys
from pathlib import Path

import zvec

AGENTS_DIR = Path.home() / ".agents"
DB_PATH = AGENTS_DIR / "memory" / "memories.db"
ZVEC_PATH = AGENTS_DIR / "memory" / "vectors.zvec"


def export_embeddings():
    """Export all embeddings with their memory data."""
    if not DB_PATH.exists():
        return {"error": "No database found", "embeddings": []}
    
    if not ZVEC_PATH.exists():
        return {"error": "No vector store found", "embeddings": []}
    
    # Open database
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    
    # Get all memories
    rows = db.execute("""
        SELECT id, content, who, importance, tags, created_at 
        FROM memories 
        ORDER BY created_at DESC
    """).fetchall()
    
    # Open zvec collection
    try:
        collection = zvec.open(path=str(ZVEC_PATH))
    except Exception as e:
        db.close()
        return {"error": f"Failed to open vector store: {e}", "embeddings": []}
    
    embeddings = []
    
    for row in rows:
        memory_id = str(row["id"])
        
        # Try to get vector from zvec
        # Use a self-query: search for exact match
        try:
            # Unfortunately zvec doesn't have a direct get-by-id
            # We'll use the memory content to search and verify ID
            # For now, skip the vector data and just include metadata
            # The UMAP will run client-side only if we have vectors
            
            embeddings.append({
                "id": memory_id,
                "text": row["content"],
                "who": row["who"] or "unknown",
                "importance": row["importance"] or 0.5,
                "tags": row["tags"],
                "createdAt": row["created_at"],
                # Vector will be loaded separately or we compute PCA server-side
            })
        except Exception:
            continue
    
    db.close()
    
    return {"embeddings": embeddings, "count": len(embeddings)}


def export_with_vectors():
    """Export embeddings with actual vector data for UMAP."""
    if not DB_PATH.exists():
        return {"error": "No database found", "embeddings": []}
    
    if not ZVEC_PATH.exists():
        return {"error": "No vector store found", "embeddings": []}
    
    # Import embeddings module for re-embedding
    sys.path.insert(0, str(AGENTS_DIR / "memory" / "scripts"))
    from embeddings import embed
    import yaml
    
    # Load config
    config_path = AGENTS_DIR / "config.yaml"
    config = {}
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f)
    
    # Open database
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    
    # Get all memories
    rows = db.execute("""
        SELECT id, content, who, importance, tags, created_at 
        FROM memories 
        ORDER BY created_at DESC
        LIMIT 200
    """).fetchall()
    
    embeddings = []
    
    for row in rows:
        memory_id = str(row["id"])
        content = row["content"]
        
        try:
            # Re-embed to get vector (cached by ollama)
            vector, _ = embed(content, config)
            
            embeddings.append({
                "id": memory_id,
                "text": content[:200],  # Truncate for JSON size
                "who": row["who"] or "unknown",
                "importance": row["importance"] or 0.5,
                "tags": row["tags"],
                "createdAt": row["created_at"],
                "vector": vector,
            })
        except Exception as e:
            # Skip memories we can't embed
            continue
    
    db.close()
    
    return {"embeddings": embeddings, "count": len(embeddings)}


if __name__ == "__main__":
    # If --with-vectors flag, include vector data
    if len(sys.argv) > 1 and sys.argv[1] == "--with-vectors":
        result = export_with_vectors()
    else:
        result = export_embeddings()
    
    print(json.dumps(result))
