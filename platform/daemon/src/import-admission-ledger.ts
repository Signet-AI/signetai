import { randomUUID } from "node:crypto";
import type { DbAccessor } from "./db-accessor";
import { runDbOwnerDomainOperation } from "./db-owner-runtime";
import type { DbOwnerRequest, DbOwnerStatement } from "./db-owner-protocol";
import type { ImportLedger, ImportRow, ImportStatus } from "./import-inbox";

export class ImportAdmissionConflictError extends Error {
	constructor(key: string) {
		super(`import admission key conflict: ${key}`);
		this.name = "ImportAdmissionConflictError";
	}
}

type Row = {
	key: string;
	agent_id: string;
	workspace_id: string;
	file_name: string;
	status: ImportStatus;
	original_path: string;
	sha256: string;
	size_bytes: number;
	request_fingerprint: string;
	source_id: string | null;
	error: string | null;
};
const now = () => new Date().toISOString();
const statement = (
	sql: string,
	params: (string | number | null)[],
	result: "get" | "run" | "all",
): DbOwnerStatement => ({ sql, params, result, transactional: result === "run" });

export interface ImportAdmissionScope {
	agentId: string;
	workspaceId?: string;
}
export class DbOwnedImportAdmissionLedger implements ImportLedger {
	constructor(
		private readonly accessor: DbAccessor,
		private readonly scope: ImportAdmissionScope,
	) {}
	private async request<T>(request: DbOwnerRequest, operation: string): Promise<T> {
		return runDbOwnerDomainOperation(this.accessor, {
			runInline: (access) =>
				access.read((_db) => {
					throw new Error(`inline import admission requires owner: ${operation}`);
				}),
			runWithOwner: async (owner) =>
				owner.awaitResult<T>(
					owner.submit<T>(request, {
						operation,
						lane: request.kind === "query" && request.statement.result !== "run" ? "read" : "write",
						deadlineMs: 10_000,
						estimatedWorkUnits: 1,
					}),
				),
		});
	}
	private row(row: Row): ImportRow {
		return {
			key: row.key,
			fileName: row.file_name,
			status: row.status,
			originalPath: row.original_path,
			sha256: row.sha256,
			size: row.size_bytes,
			...(row.source_id ? { sourceId: row.source_id } : {}),
			...(row.error ? { error: row.error } : {}),
		};
	}
	async find(key: string): Promise<ImportRow | undefined> {
		const r = await this.request<Row | undefined>(
			{
				kind: "query",
				statement: statement(
					"SELECT * FROM import_admission_ledger WHERE key = ? AND agent_id = ? AND workspace_id = ?",
					[key, this.scope.agentId, this.scope.workspaceId ?? ""],
					"get",
				),
			},
			"import-admission.find",
		);
		return r ? this.row(r) : undefined;
	}
	async upsert(row: ImportRow): Promise<ImportRow> {
		const fingerprint = `${row.fileName}\0${row.sha256}\0${row.size}`;
		const existing = await this.request<Row | undefined>(
			{
				kind: "query",
				statement: statement(
					"SELECT * FROM import_admission_ledger WHERE key = ? AND agent_id = ? AND workspace_id = ?",
					[row.key, this.scope.agentId, this.scope.workspaceId ?? ""],
					"get",
				),
			},
			"import-admission.lookup",
		);
		if (existing) {
			if (existing.request_fingerprint && existing.request_fingerprint !== fingerprint)
				throw new ImportAdmissionConflictError(row.key);
			return this.row(existing);
		}
		const timestamp = now();
		const req = {
			kind: "transaction",
			transaction: {
				statements: [
					statement(
						"INSERT INTO import_admission_ledger (key,agent_id,workspace_id,file_name,status,original_path,sha256,size_bytes,request_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
						[
							row.key,
							this.scope.agentId,
							this.scope.workspaceId ?? "",
							row.fileName,
							row.status,
							row.originalPath,
							row.sha256,
							row.size,
							fingerprint,
							timestamp,
							timestamp,
						],
						"run",
					),
					statement(
						"INSERT INTO import_admission_events (admission_key,event,created_at) VALUES (?,?,?)",
						[row.key, "admitted", timestamp],
						"run",
					),
				],
			},
		} as DbOwnerRequest;
		await this.request(req, "import-admission.upsert");
		return row;
	}
	async appendEvent(key: string, event: string): Promise<void> {
		await this.request(
			{
				kind: "query",
				statement: statement(
					"INSERT INTO import_admission_events (admission_key,event,created_at) VALUES (?,?,?)",
					[key, event, now()],
					"run",
				),
			},
			"import-admission.event",
		);
	}
	async transition(
		key: string,
		from: ImportStatus | ImportStatus[],
		to: ImportStatus,
		error?: string,
		options?: { readonly sourceId?: string },
	): Promise<ImportRow> {
		const allowed = Array.isArray(from) ? from : [from];
		const timestamp = now();
		const r = await this.request<[{ changes: number }, unknown]>(
			{
				kind: "transaction",
				transaction: {
					statements: [
						{
							...statement(
								`UPDATE import_admission_ledger SET status = ?, error = ?, source_id = COALESCE(?, source_id), updated_at = ? WHERE key = ? AND agent_id = ? AND workspace_id = ? AND status IN (${allowed.map(() => "?").join(",")})`,
								[
									to,
									error ?? null,
									options?.sourceId ?? null,
									timestamp,
									key,
									this.scope.agentId,
									this.scope.workspaceId ?? "",
									...allowed,
								],
								"run",
							),
							requireChanges: true,
						},
						statement(
							"INSERT INTO import_admission_events (admission_key,event,created_at) VALUES (?,?,?)",
							[key, to, timestamp],
							"run",
						),
					],
				},
			},
			"import-admission.transition",
		);
		if (!r[0].changes) throw new Error(`invalid import transition for ${key}`);
		const row = await this.find(key);
		if (!row) throw new Error(`missing import ${key}`);
		return row;
	}
	async list(status?: ImportStatus): Promise<ImportRow[]> {
		const rows = await this.request<Row[]>(
			{
				kind: "query",
				statement: statement(
					`SELECT * FROM import_admission_ledger WHERE agent_id = ? AND workspace_id = ? ${status ? "AND status = ?" : ""} ORDER BY updated_at`,
					[this.scope.agentId, this.scope.workspaceId ?? "", ...(status ? [status] : [])],
					"all",
				),
			},
			"import-admission.list",
		);
		return rows.map((r) => this.row(r));
	}
	async markOriginalUnavailable(key: string): Promise<ImportRow> {
		return this.transition(
			key,
			["pending", "processing", "failed", "imported", "duplicate"],
			"original_unavailable",
			"managed original is unavailable",
		);
	}
	async recoverExpiredLeases(): Promise<number> {
		const r = await this.request<{ changes: number }>(
			{
				kind: "query",
				statement: statement(
					"UPDATE import_admission_ledger SET status='pending', lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE agent_id=? AND workspace_id=? AND status='processing' AND lease_expires_at < ?",
					[now(), this.scope.agentId, this.scope.workspaceId ?? "", now()],
					"run",
				),
			},
			"import-admission.recover",
		);
		return r.changes;
	}
	async lease(key: string, leaseMs = 60_000): Promise<string> {
		const token = randomUUID();
		const expires = new Date(Date.now() + leaseMs).toISOString();
		const r = await this.request<{ changes: number }>(
			{
				kind: "query",
				statement: statement(
					"UPDATE import_admission_ledger SET status='processing', lease_token=?, lease_expires_at=?, attempt_count=attempt_count+1, updated_at=? WHERE key=? AND agent_id=? AND workspace_id=? AND status IN ('pending','failed')",
					[token, expires, now(), key, this.scope.agentId, this.scope.workspaceId ?? ""],
					"run",
				),
			},
			"import-admission.lease",
		);
		if (!r.changes) throw new Error(`import is not leaseable: ${key}`);
		return token;
	}
}
