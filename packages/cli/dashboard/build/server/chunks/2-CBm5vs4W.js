import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const AGENTS_DIR = join(homedir(), ".agents");
const MEMORY_DB = join(AGENTS_DIR, "memory", "memories.db");
function parseIdentity(content) {
  const lines = content.split("\n");
  const identity = { name: "", creature: "", vibe: "" };
  for (const line of lines) {
    if (line.startsWith("- name:"))
      identity.name = line.replace("- name:", "").trim();
    if (line.startsWith("- creature:"))
      identity.creature = line.replace("- creature:", "").trim();
    if (line.startsWith("- vibe:"))
      identity.vibe = line.replace("- vibe:", "").trim();
  }
  return identity;
}
async function loadIdentity() {
  try {
    const content = await readFile(
      join(AGENTS_DIR, "IDENTITY.md"),
      "utf-8"
    );
    return parseIdentity(content);
  } catch {
    return { name: "Unknown", creature: "", vibe: "" };
  }
}
async function loadConfigFiles() {
  const files = [];
  try {
    const dirFiles = await readdir(AGENTS_DIR);
    const configFiles = dirFiles.filter(
      (f) => f.endsWith(".md") || f.endsWith(".yaml")
    );
    for (const fileName of configFiles) {
      const filePath = join(AGENTS_DIR, fileName);
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        const content = await readFile(filePath, "utf-8");
        files.push({ name: fileName, content, size: fileStat.size });
      }
    }
  } catch (e) {
    console.error("Error reading config files:", e);
  }
  const priority = [
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "config.yaml"
  ];
  files.sort((a, b) => {
    const aIdx = priority.indexOf(a.name);
    const bIdx = priority.indexOf(b.name);
    if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });
  return files;
}
async function loadMemories() {
  let memories = [];
  const stats = { total: 0, withEmbeddings: 0, critical: 0 };
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    const totalResult = db.prepare(
      "SELECT COUNT(*) as count FROM memories"
    ).get();
    stats.total = totalResult?.count ?? 0;
    try {
      const embResult = db.prepare(
        "SELECT COUNT(*) as count FROM embeddings"
      ).get();
      stats.withEmbeddings = embResult?.count ?? 0;
    } catch {
    }
    const critResult = db.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE importance >= 0.9"
    ).get();
    stats.critical = critResult?.count ?? 0;
    memories = db.prepare(`
      SELECT id, content, created_at, who, importance, tags, source_type
      FROM memories ORDER BY created_at DESC LIMIT 100
    `).all();
    db.close();
  } catch (e) {
    console.error("Error reading memory database:", e);
  }
  return { memories, stats };
}
async function loadHarnesses() {
  const configs = [
    { name: "Claude Code", path: join(homedir(), ".claude", "CLAUDE.md") },
    {
      name: "OpenCode",
      path: join(homedir(), ".config", "opencode", "AGENTS.md")
    },
    {
      name: "OpenClaw (Source)",
      path: join(AGENTS_DIR, "AGENTS.md")
    }
  ];
  const harnesses = [];
  for (const config of configs) {
    let exists = false;
    try {
      await stat(config.path);
      exists = true;
    } catch {
    }
    harnesses.push({
      name: config.name,
      path: config.path,
      exists
    });
  }
  return harnesses;
}
const load = async () => {
  const [identity, configFiles, memoryData, harnesses] = await Promise.all([
    loadIdentity(),
    loadConfigFiles(),
    loadMemories(),
    loadHarnesses()
  ]);
  return {
    identity,
    configFiles,
    memories: memoryData.memories,
    memoryStats: memoryData.stats,
    harnesses
  };
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
  __proto__: null,
  load: load
});

const index = 2;
let component_cache;
const component = async () => component_cache ??= (await import('./_page.svelte-TX48LZWl.js')).default;
const server_id = "src/routes/+page.server.ts";
const imports = ["_app/immutable/nodes/2.SGc1XGmR.js","_app/immutable/chunks/CejlkohN.js","_app/immutable/chunks/DOXm6QVJ.js","_app/immutable/chunks/QHD0JZ7V.js","_app/immutable/chunks/CLc--whT.js","_app/immutable/chunks/DLxKCE5P.js"];
const stylesheets = ["_app/immutable/assets/2.DVKnOaiD.css"];
const fonts = [];

export { component, fonts, imports, index, _page_server_ts as server, server_id, stylesheets };
//# sourceMappingURL=2-CBm5vs4W.js.map
