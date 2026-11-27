import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../../core/src/migrations";
import { up } from "../../../core/src/migrations/177-classifications";
export function classificationFixture(path = ":memory:") {
	const db = new Database(path);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL");
	for (const m of MIGRATIONS) if (m.version < 177) m.up(db);
	db.exec(
		"INSERT INTO users(id,username,display_name,role) VALUES('alice','alice','Alice','member'),('bob','bob','Bob','member'),('carol','carol','Carol','member')",
	);
	up(db);
	db.exec(
		`INSERT INTO memories(id,content,agent_id,author_user_id,created_at,updated_at) VALUES('m','private secret','default','alice','now','now'); INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('e','E','e','concept','default','now','now'); INSERT INTO evidence_citations VALUES('entity','e','default','memory','m');`,
	);
	return db;
}
export function currentClassificationFixture(db = classificationFixture()) {
	for (const migration of MIGRATIONS) if (migration.version > 177) migration.up(db);
	return db;
}
