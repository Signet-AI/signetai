import { Database } from "../../../core/src/database";
import { runMigrations } from "../../../core/src/migrations/index";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("usage: bun generate_ts_157_fixture.ts <output.sqlite>");
try { rmSync(output); } catch {}
mkdirSync(dirname(output), { recursive: true });
const database = new Database(output);
await database.init();
const sqlite = (database as unknown as { db: { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } } }).db;
const db = {
  exec: (sql: string) => sqlite.exec(sql),
  prepare: (sql: string) => {
    const statement = sqlite.prepare(sql);
    return {
      run: (...args: unknown[]) => statement.run(...args),
      get: (...args: unknown[]) => statement.get(...args) as Record<string, unknown> | undefined,
      all: (...args: unknown[]) => statement.all(...args) as Record<string, unknown>[],
    };
  },
};
try {
  // The fixture is generated from PR-base TypeScript revision 7a46e8227b4f2a3ad629f0de80ebce02330967bd through v157.
  // The immutable corpus reference at 11e4720c07107caf7fdd57a685eca24e8a82e654 ends at v153; rerunning
  // the current registry verifies idempotence before representative rows are added.
  runMigrations(db as never);
  db.exec("INSERT INTO agents(id,name,created_at,updated_at) VALUES ('fixture-agent','Fixture Agent','2026-09-26T11:00:00.000Z','2026-09-26T11:00:00.000Z') ON CONFLICT(id) DO NOTHING");
  db.exec("INSERT INTO embedding_repair_checkpoints(checkpoint_id,agent_id,model,status,batches,selected,written,failed,stale,cross_agent_hash_conflicts,last_error,created_at,updated_at,profile_fingerprint) VALUES ('fixture-checkpoint','fixture-agent','fixture-model','failed',2,8,5,1,1,1,'preserve this','2026-09-26T11:00:00.000Z','2026-09-26T11:30:00.000Z','fixture-fingerprint')");
  db.exec("INSERT INTO embedding_repair_progress(agent_id,last_completed_at,last_affected,last_error,updated_at) VALUES ('fixture-agent','2026-09-26T10:00:00.000Z',8,'preserve progress','2026-09-26T11:45:00.000Z')");
} finally { database.close(); }
console.log(`generated ${output}`);
