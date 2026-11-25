import { authoredAuditStatements, type WriteAuthor } from "./auth/audit-owner";
import type { CrossAgentMessageRow } from "./cross-agent";
import type { DbOwnerStatement } from "./db-owner-protocol";
import { dbOwnerTransaction } from "./db-owner-runtime";
export class AgentMessageCapacityError extends Error {
	constructor() {
		super("Cross-agent message capacity reached; wait for retention cleanup before retrying");
		this.name = "AgentMessageCapacityError";
	}
}
const columns = [
	"id",
	"from_agent_id",
	"from_session_key",
	"to_agent_id",
	"to_session_key",
	"to_session_agent_id",
	"broadcast",
	"message_type",
	"content",
	"delivery_path",
	"delivery_status",
	"delivery_state",
	"delivery_attempt_id",
	"delivery_attempts",
	"delivery_lease_token",
	"delivery_lease_expires_at",
	"delivery_attempt_started_at",
	"delivery_updated_at",
	"delivery_error",
	"delivery_receipt_json",
	"acp_base_url",
	"acp_target_agent_name",
	"acp_timeout_ms",
	"acp_metadata_json",
	"created_at",
	"expires_at",
] as const;
export function agentMessageWriteStatements(
	row: CrossAgentMessageRow,
	author: WriteAuthor | undefined,
): readonly DbOwnerStatement[] {
	return [
		{
			sql: "DELETE FROM cross_agent_message_wakes WHERE message_id IN (SELECT id FROM cross_agent_messages WHERE expires_at <= ?)",
			params: [row.created_at],
			result: "run",
		},
		{ sql: "DELETE FROM cross_agent_messages WHERE expires_at <= ?", params: [row.created_at], result: "run" },
		{
			sql: `INSERT INTO cross_agent_messages (${columns.join(",")},author_user_id,compartment_id) SELECT ${columns.map(() => "?").join(",")},?,? WHERE (SELECT COUNT(*) FROM cross_agent_messages) < 10000`,
			params: [
				...columns.map((name) => row[name]),
				author?.userId ?? null,
				{ type: "compartment", scope: { agentId: row.from_agent_id, sessionKey: row.from_session_key } },
			],
			result: "run",
			requireChanges: true,
		},

		...authoredAuditStatements(author, "message.created", "message", row.id, row.from_agent_id),
	];
}
export async function persistAgentMessage(row: CrossAgentMessageRow, author: WriteAuthor | undefined): Promise<void> {
	try {
		await dbOwnerTransaction(agentMessageWriteStatements(row, author), {
			operation: "cross-agent.message.create",
			lane: "write",
			deadlineMs: 5000,
		});
	} catch (error) {
		if (error instanceof Error && error.message === "DB owner transaction precondition changed zero rows")
			throw new AgentMessageCapacityError();
		throw error;
	}
}
