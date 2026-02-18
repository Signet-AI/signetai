import { json } from "@sveltejs/kit";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
const MEMORY_DB = join(homedir(), ".agents", "memory", "memories.db");
const GET = async ({ url }) => {
  const query = url.searchParams.get("q") ?? "";
  if (!query.trim()) {
    return json({ results: [] });
  }
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    let results = [];
    try {
      results = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.who, m.importance, m.tags,
               bm25(memories_fts) as score
        FROM memories_fts
        JOIN memories m ON memories_fts.rowid = m.rowid
        WHERE memories_fts MATCH ?
        ORDER BY score
        LIMIT 20
      `).all(query);
    } catch {
      results = db.prepare(`
        SELECT id, content, created_at, who, importance, tags
        FROM memories
        WHERE content LIKE ? OR tags LIKE ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(`%${query}%`, `%${query}%`);
    }
    db.close();
    return json({ results });
  } catch (e) {
    console.error("Error searching memories:", e);
    return json({ results: [], error: "Search failed" });
  }
};
export {
  GET
};
