import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../../core/src/migrations";
import { up } from "../../../core/src/migrations/177-classifications";
export function classificationFixture() {
	const db = new Database(":memory:");
	for (const m of MIGRATIONS) if (m.version < 176) m.up(db);
	db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,email TEXT UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','member','readonly')),compliance INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated')),password_hash TEXT,oidc_issuer TEXT,oidc_subject TEXT,personal_agent_id TEXT,default_read_agent_id TEXT,created_at TEXT,updated_at TEXT,deactivated_at TEXT,last_active_at TEXT,UNIQUE(oidc_issuer,oidc_subject));
 CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,description TEXT,managed_by TEXT NOT NULL DEFAULT 'signet' CHECK(managed_by IN ('signet','idp')),idp_group TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE group_members(group_id TEXT,user_id TEXT,role TEXT NOT NULL CHECK(role IN ('owner','member')),managed_by TEXT NOT NULL DEFAULT 'signet',created_at TEXT,PRIMARY KEY(group_id,user_id));
 CREATE TABLE audit_events(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor_user_id TEXT,actor_credential TEXT,action TEXT NOT NULL,target_kind TEXT,target_id TEXT,agent_id TEXT,outcome TEXT NOT NULL CHECK(outcome IN ('ok','denied','failed')),detail_json TEXT);
 CREATE TABLE org_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','running','complete','failed','cancelled')),params_json TEXT,progress_json TEXT,error TEXT,created_by TEXT,created_at TEXT,started_at TEXT,finished_at TEXT);
 ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'; ALTER TABLE agents ADD COLUMN owner_user_id TEXT;ALTER TABLE agents ADD COLUMN owner_group_id TEXT;ALTER TABLE agents ADD COLUMN archived_at TEXT;
 ALTER TABLE memories ADD COLUMN author_user_id TEXT;ALTER TABLE session_transcripts ADD COLUMN speaker_user_id TEXT;ALTER TABLE memory_artifacts ADD COLUMN author_user_id TEXT;
 INSERT INTO users(id,username,display_name,role) VALUES('alice','alice','Alice','member'),('bob','bob','Bob','member'),('carol','carol','Carol','member');`);
	up(db);
	db.exec(
		`INSERT INTO memories(id,content,agent_id,author_user_id,created_at,updated_at) VALUES('m','private secret','default','alice','now','now'); INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('e','E','e','concept','default','now','now'); INSERT INTO evidence_citations VALUES('entity','e','default','memory','m');`,
	);
	return db;
}
