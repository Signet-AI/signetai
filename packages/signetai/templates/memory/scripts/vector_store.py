#!/usr/bin/env python3
"""
Vector store for Signet memory system using zvec.

Usage:
    vector_store.py init                    Initialize vector collection
    vector_store.py insert <id> <vector>    Insert vector (JSON array)
    vector_store.py search <vector> [k]     Search similar vectors
    vector_store.py delete <id>             Delete vector by ID
    vector_store.py stats                   Show collection statistics
    vector_store.py reindex                 Reindex all memories
"""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Optional

import yaml

try:
    import zvec
    ZVEC_AVAILABLE = True
except ImportError:
    ZVEC_AVAILABLE = False
    zvec = None

CONFIG_PATH = Path.home() / ".agents/config.yaml"
DEFAULT_VECTOR_PATH = Path.home() / ".agents/memory/vectors.zvec"
DEFAULT_DB_PATH = Path.home() / ".agents/memory/memories.db"


def load_config() -> dict:
    """Load configuration from config.yaml"""
    if not CONFIG_PATH.exists():
        return {
            "embeddings": {"dimensions": 768},
            "search": {"top_k": 20},
            "paths": {
                "vectors": "memory/vectors.zvec",
                "database": "memory/memories.db",
            }
        }
    
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def get_vector_path(config: Optional[dict] = None) -> Path:
    """Get vector store path from config"""
    if config is None:
        config = load_config()
    
    rel_path = config.get("paths", {}).get("vectors", "memory/vectors.zvec")
    return Path.home() / ".agents" / rel_path


def get_dimensions(config: Optional[dict] = None) -> int:
    """Get embedding dimensions from config"""
    if config is None:
        config = load_config()
    return config.get("embeddings", {}).get("dimensions", 768)


def init_collection(config: Optional[dict] = None) -> zvec.Collection:
    """Initialize or open the vector collection"""
    if config is None:
        config = load_config()
    
    vector_path = get_vector_path(config)
    dimensions = get_dimensions(config)
    
    # Ensure parent directory exists
    vector_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Define schema
    schema = zvec.CollectionSchema(
        name="memories",
        vectors=zvec.VectorSchema("embedding", zvec.DataType.VECTOR_FP32, dimensions),
    )
    
    # Create or open collection
    if vector_path.exists():
        try:
            collection = zvec.open(path=str(vector_path))
            return collection
        except Exception:
            # Collection might be corrupted or wrong schema, recreate
            pass
    
    collection = zvec.create_and_open(path=str(vector_path), schema=schema)
    return collection


def insert_vector(memory_id: str, vector: list[float], config: Optional[dict] = None) -> bool:
    """Insert a vector into the collection"""
    collection = init_collection(config)
    
    try:
        # Delete existing if present (upsert behavior)
        try:
            collection.delete([memory_id])
        except Exception:
            pass
        
        # Insert new vector
        doc = zvec.Doc(id=memory_id, vectors={"embedding": vector})
        collection.insert([doc])
        return True
    except Exception as e:
        print(f"Error inserting vector: {e}", file=sys.stderr)
        return False


def search_vectors(query_vector: list[float], k: int = 20, config: Optional[dict] = None) -> list[dict]:
    """Search for similar vectors, returns list of {id, score}"""
    collection = init_collection(config)
    
    try:
        results = collection.query(
            zvec.VectorQuery("embedding", vector=query_vector),
            topk=k
        )
        
        # zvec returns Doc objects with .id and .score attributes
        return [{"id": r.id, "score": float(r.score)} for r in results]
    except Exception as e:
        print(f"Error searching vectors: {e}", file=sys.stderr)
        return []


def delete_vector(memory_id: str, config: Optional[dict] = None) -> bool:
    """Delete a vector by ID"""
    collection = init_collection(config)
    
    try:
        collection.delete([memory_id])
        return True
    except Exception as e:
        print(f"Error deleting vector: {e}", file=sys.stderr)
        return False


def get_stats(config: Optional[dict] = None) -> dict:
    """Get collection statistics"""
    try:
        collection = init_collection(config)
        # zvec doesn't have a direct stats method, but we can check if it's working
        return {
            "path": str(get_vector_path(config)),
            "dimensions": get_dimensions(config),
            "available": True,
        }
    except Exception as e:
        return {
            "path": str(get_vector_path(config)),
            "dimensions": get_dimensions(config),
            "available": False,
            "error": str(e),
        }


def reindex_all(config: Optional[dict] = None):
    """Reindex all memories from the database"""
    if config is None:
        config = load_config()
    
    # Import embeddings module
    from embeddings import embed
    
    # Get database path
    db_path = Path.home() / ".agents" / config.get("paths", {}).get("database", "memory/memories.db")
    
    if not db_path.exists():
        print("No database found", file=sys.stderr)
        return
    
    # Connect to database
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    
    # Get all memories
    rows = db.execute("SELECT id, content FROM memories").fetchall()
    
    print(f"Reindexing {len(rows)} memories...")
    
    success = 0
    failed = 0
    
    for row in rows:
        memory_id = str(row["id"])
        content = row["content"]
        
        try:
            vector, _ = embed(content, config)
            if insert_vector(memory_id, vector, config):
                success += 1
            else:
                failed += 1
        except Exception as e:
            print(f"Failed to embed memory {memory_id}: {e}", file=sys.stderr)
            failed += 1
    
    print(f"Reindexed: {success} success, {failed} failed")
    db.close()


def main():
    if not ZVEC_AVAILABLE:
        print("Error: zvec not installed (requires Python 3.10-3.12)", file=sys.stderr)
        print("Install with: pip install zvec", file=sys.stderr)
        sys.exit(1)
    
    parser = argparse.ArgumentParser(description="Signet vector store")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # init command
    subparsers.add_parser("init", help="Initialize vector collection")
    
    # insert command
    insert_parser = subparsers.add_parser("insert", help="Insert vector")
    insert_parser.add_argument("id", help="Memory ID")
    insert_parser.add_argument("vector", help="Vector as JSON array")
    
    # search command
    search_parser = subparsers.add_parser("search", help="Search similar vectors")
    search_parser.add_argument("vector", help="Query vector as JSON array")
    search_parser.add_argument("k", nargs="?", type=int, default=20, help="Number of results")
    
    # delete command
    delete_parser = subparsers.add_parser("delete", help="Delete vector")
    delete_parser.add_argument("id", help="Memory ID")
    
    # stats command
    subparsers.add_parser("stats", help="Show collection statistics")
    
    # reindex command
    subparsers.add_parser("reindex", help="Reindex all memories")
    
    args = parser.parse_args()
    
    if args.command == "init":
        try:
            collection = init_collection()
            print(f"Vector collection initialized at {get_vector_path()}")
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    
    elif args.command == "insert":
        vector = json.loads(args.vector)
        if insert_vector(args.id, vector):
            print(f"Inserted vector for {args.id}")
        else:
            sys.exit(1)
    
    elif args.command == "search":
        vector = json.loads(args.vector)
        results = search_vectors(vector, args.k)
        print(json.dumps(results, indent=2))
    
    elif args.command == "delete":
        if delete_vector(args.id):
            print(f"Deleted vector for {args.id}")
        else:
            sys.exit(1)
    
    elif args.command == "stats":
        stats = get_stats()
        print(json.dumps(stats, indent=2))
    
    elif args.command == "reindex":
        reindex_all()


if __name__ == "__main__":
    main()
