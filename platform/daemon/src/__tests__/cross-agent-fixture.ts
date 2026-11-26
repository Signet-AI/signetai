import { compartmentForWrite, findSqliteVecExtension } from "@signet/core";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { buildAgentMessageRow, type CreateAgentMessageInput, publishAgentMessage } from "../cross-agent";
import { AgentMessageCapacityError, agentMessageWriteStatements } from "../cross-agent-message-owner";
import { closeDbAccessor, getDbAccessorPath } from "../db-accessor";
export async function closeCrossAgentFixture() {
	await (await import("../db-owner-runtime")).closeDbOwner();
	await closeDbAccessor();
}
export function createAgentMessage(input: CreateAgentMessageInput) {
	const row = buildAgentMessageRow(input);
	const path = getDbAccessorPath();
	if (!path) throw new Error("Fixture database is not initialized");
	const db = new Database(path);
	const extension = findSqliteVecExtension();
	if (extension) db.loadExtension(extension);
	const migrationDb = {
		exec(sql: string) {
			db.exec(sql);
		},
		prepare(sql: string) {
			const query = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
			return {
				get(...params: SQLQueryBindings[]) {
					return query.get(...params) ?? undefined;
				},
				all(...params: SQLQueryBindings[]) {
					return query.all(...params);
				},
				run(...params: SQLQueryBindings[]) {
					return query.run(...params);
				},
			};
		},
	};
	try {
		db.exec("BEGIN IMMEDIATE");
		for (const agentId of [row.from_agent_id, row.to_agent_id, row.to_session_agent_id])
			if (agentId)
				db.prepare(
					"INSERT OR IGNORE INTO agents(id,name,created_at,updated_at) VALUES(?,?,datetime('now'),datetime('now'))",
				).run(agentId, agentId);
		try {
			for (const statement of agentMessageWriteStatements(row, input.author)) {
				const prepared = db.prepare(statement.sql);
				try {
					const params = (statement.params ?? []).map((value) => {
						if (value !== null && typeof value === "object") {
							if (value.type === "bytes") return Buffer.from(value.base64, "base64");
							if (value.type === "compartment") return compartmentForWrite(migrationDb, value.scope);
							throw new Error("Agent-message fixture does not support compartment parameters");
						}
						return value;
					});
					const result = prepared.run(...params);
					if (statement.requireChanges && result.changes === 0) throw new AgentMessageCapacityError();
				} finally {
					prepared.finalize();
				}
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close(true);
	}
	return publishAgentMessage(row);
}
