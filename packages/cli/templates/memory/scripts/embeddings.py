#!/usr/bin/env python3
"""
Embedding generation for Signet memory system.
Supports Ollama and OpenAI-compatible APIs.

Usage:
    embeddings.py embed <text>              Generate embedding for text
    embeddings.py embed-batch <file>        Generate embeddings for JSONL file
    embeddings.py status                    Check embedding provider status
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error

import yaml

CONFIG_PATH = Path.home() / ".agents/config.yaml"


def load_config() -> dict:
    """Load configuration from config.yaml"""
    if not CONFIG_PATH.exists():
        return {
            "embeddings": {
                "provider": "ollama",
                "model": "nomic-embed-text",
                "dimensions": 768,
                "base_url": "http://localhost:11434",
            }
        }
    
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def get_api_key() -> Optional[str]:
    """Get API key from config or environment"""
    config = load_config()
    key = config.get("embeddings", {}).get("api_key")
    if key:
        return key
    return os.environ.get("OPENAI_API_KEY")


def content_hash(text: str) -> str:
    """Generate SHA-256 hash of content for deduplication"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embed_ollama(text: str, model: str, base_url: str) -> list[float]:
    """Generate embedding using Ollama API"""
    url = f"{base_url.rstrip('/')}/api/embeddings"
    
    payload = json.dumps({
        "model": model,
        "prompt": text,
    }).encode("utf-8")
    
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["embedding"]
    except urllib.error.URLError as e:
        raise RuntimeError(f"Ollama API error: {e}")


def embed_openai(text: str, model: str, base_url: str, api_key: str) -> list[float]:
    """Generate embedding using OpenAI-compatible API"""
    url = f"{base_url.rstrip('/')}/embeddings"
    
    payload = json.dumps({
        "model": model,
        "input": text,
    }).encode("utf-8")
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["data"][0]["embedding"]
    except urllib.error.URLError as e:
        raise RuntimeError(f"OpenAI API error: {e}")


def embed(text: str, config: Optional[dict] = None) -> tuple[list[float], str]:
    """
    Generate embedding for text.
    Returns (embedding_vector, content_hash)
    """
    if config is None:
        config = load_config()
    
    emb_config = config.get("embeddings", {})
    provider = emb_config.get("provider", "ollama")
    model = emb_config.get("model", "nomic-embed-text")
    base_url = emb_config.get("base_url", "http://localhost:11434")
    
    # Normalize text
    text = text.strip()
    if not text:
        raise ValueError("Empty text")
    
    # Generate hash for deduplication
    text_hash = content_hash(text)
    
    # Generate embedding based on provider
    if provider == "ollama":
        vector = embed_ollama(text, model, base_url)
    elif provider == "openai":
        api_key = get_api_key()
        if not api_key:
            raise ValueError("OpenAI API key required (set OPENAI_API_KEY or config.yaml)")
        vector = embed_openai(text, model, base_url, api_key)
    else:
        raise ValueError(f"Unknown provider: {provider}")
    
    return vector, text_hash


def embed_batch(texts: list[str], config: Optional[dict] = None) -> list[tuple[list[float], str]]:
    """Generate embeddings for multiple texts"""
    results = []
    for text in texts:
        try:
            vector, text_hash = embed(text, config)
            results.append((vector, text_hash))
        except Exception as e:
            print(f"Warning: Failed to embed text: {e}", file=sys.stderr)
            results.append((None, content_hash(text)))
    return results


def check_status() -> dict:
    """Check embedding provider status"""
    config = load_config()
    emb_config = config.get("embeddings", {})
    provider = emb_config.get("provider", "ollama")
    model = emb_config.get("model", "nomic-embed-text")
    base_url = emb_config.get("base_url", "http://localhost:11434")
    
    status = {
        "provider": provider,
        "model": model,
        "base_url": base_url,
        "available": False,
        "error": None,
    }
    
    try:
        # Test with a simple embedding
        vector, _ = embed("test", config)
        status["available"] = True
        status["dimensions"] = len(vector)
    except Exception as e:
        status["error"] = str(e)
    
    return status


def main():
    parser = argparse.ArgumentParser(description="Signet embedding generator")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # embed command
    embed_parser = subparsers.add_parser("embed", help="Generate embedding for text")
    embed_parser.add_argument("text", nargs="?", help="Text to embed (or stdin)")
    
    # embed-batch command
    batch_parser = subparsers.add_parser("embed-batch", help="Embed JSONL file")
    batch_parser.add_argument("file", help="JSONL file with 'text' field per line")
    
    # status command
    subparsers.add_parser("status", help="Check embedding provider status")
    
    args = parser.parse_args()
    
    if args.command == "embed":
        text = args.text if args.text else sys.stdin.read().strip()
        if not text:
            print("Error: No text provided", file=sys.stderr)
            sys.exit(1)
        
        try:
            vector, text_hash = embed(text)
            result = {
                "hash": text_hash,
                "dimensions": len(vector),
                "vector": vector,
            }
            print(json.dumps(result))
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    
    elif args.command == "embed-batch":
        file_path = Path(args.file)
        if not file_path.exists():
            print(f"Error: File not found: {file_path}", file=sys.stderr)
            sys.exit(1)
        
        with open(file_path) as f:
            for line in f:
                try:
                    data = json.loads(line.strip())
                    text = data.get("text", "")
                    if text:
                        vector, text_hash = embed(text)
                        result = {"id": data.get("id"), "hash": text_hash, "vector": vector}
                        print(json.dumps(result))
                except Exception as e:
                    print(f"Error: {e}", file=sys.stderr)
    
    elif args.command == "status":
        status = check_status()
        print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()
