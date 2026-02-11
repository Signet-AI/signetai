import { DEFAULT_HYBRID_ALPHA } from './constants';

export interface SearchOptions {
  query: string;
  limit?: number;
  alpha?: number; // Vector weight (1-alpha = BM25 weight)
  type?: 'fact' | 'preference' | 'decision';
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  type: string;
  source: 'vector' | 'keyword' | 'hybrid';
}

export async function search(
  db: any, 
  options: SearchOptions
): Promise<SearchResult[]> {
  const { query, limit = 10, alpha = DEFAULT_HYBRID_ALPHA } = options;
  
  // TODO: Implement hybrid search
  // 1. Vector similarity search (cosine)
  // 2. BM25 keyword search
  // 3. Blend with alpha weight
  
  // For now, return simple text match
  const memories = db.getMemories(options.type);
  
  const results = memories
    .filter((m: any) => 
      m.content.toLowerCase().includes(query.toLowerCase())
    )
    .slice(0, limit)
    .map((m: any) => ({
      id: m.id,
      content: m.content,
      score: 1.0,
      type: m.type,
      source: 'keyword' as const,
    }));
  
  return results;
}
