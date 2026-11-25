import { Database } from "bun:sqlite";
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
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			for (const statement of agentMessageWriteStatements(row, input.author)) {
				const prepared = db.prepare(statement.sql);
				try {
					const result = prepared.run(...(statement.params ?? []));
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
