import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AdmissionState = "open" | "draining" | "closed";

export interface MigrationAdmission {
	readonly generation: string;
	admit(owner: string, generation?: string): () => void;
}

export async function withMigrationAdmission<T>(
	admission: MigrationAdmission | undefined,
	owner: string,
	work: () => Promise<T> | T,
): Promise<T> {
	const release = admission?.admit(owner, admission.generation);
	try {
		return await work();
	} finally {
		release?.();
	}
}

export class WorkspaceMigrationRetryableError extends Error {
	readonly code = "WORKSPACE_MIGRATION_IN_PROGRESS" as const;
	readonly retryable = true as const;
	constructor(
		readonly owner: string,
		readonly generation: string,
	) {
		super(`Workspace migration is draining; writer '${owner}' must retry`);
		this.name = "WorkspaceMigrationRetryableError";
	}
}

export interface DrainBlockerReceipt {
	owner: string;
	active: number;
	queued: number;
}
export interface DrainResult {
	timedOut: boolean;
	blockers: DrainBlockerReceipt[];
}

type Writer = { active: number; queued: number };

/** Daemon-owned admission gate for every durable workspace writer. */
export class WorkspaceAdmissionBarrier {
	readonly generation: string;
	private _state: AdmissionState = "open";
	private readonly writers = new Map<string, Writer>();
	private readonly timeoutMs: number;
	constructor(generation: string, timeoutMs = 30_000) {
		if (!generation) throw new Error("generation is required");
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be non-negative");
		this.generation = generation;
		this.timeoutMs = timeoutMs;
	}
	get state(): AdmissionState {
		return this._state;
	}
	admit(owner: string, generation = this.generation): () => void {
		if (!owner) throw new Error("owner is required");
		if (generation !== this.generation || this._state !== "open")
			throw new WorkspaceMigrationRetryableError(owner, this.generation);
		const writer = this.writers.get(owner) ?? { active: 0, queued: 0 };
		writer.active += 1;
		this.writers.set(owner, writer);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			writer.active = Math.max(0, writer.active - 1);
		};
	}
	beginDrain(): void {
		if (this._state === "open") this._state = "draining";
	}
	close(): void {
		this._state = "closed";
	}
	async waitForDrain(timeoutMs = this.timeoutMs): Promise<DrainResult> {
		const end = Date.now() + timeoutMs;
		while (this.activeCount() > 0 && Date.now() < end)
			await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, end - Date.now()))));
		const blockers = this.receipts();
		if (blockers.length === 0) this.close();
		return { timedOut: blockers.length > 0, blockers };
	}
	activeCount(): number {
		return [...this.writers.values()].reduce((sum, writer) => sum + writer.active, 0);
	}
	receipts(): DrainBlockerReceipt[] {
		return [...this.writers.entries()]
			.filter(([, w]) => w.active || w.queued)
			.map(([owner, w]) => ({ owner, active: w.active, queued: w.queued }));
	}
}

export interface MigrationControlSnapshot {
	readonly generation: string;
	readonly state: AdmissionState;
	readonly blockers: DrainBlockerReceipt[];
}

/** Control-plane facade used by IPC/HTTP migration commands. */
export class MigrationControlBoundary {
	private barrier: WorkspaceAdmissionBarrier;
	private readonly timeoutMs: number;
	constructor(generation: string, timeoutMs = 30_000) {
		this.timeoutMs = timeoutMs;
		this.barrier = new WorkspaceAdmissionBarrier(generation, timeoutMs);
	}
	get generation(): string {
		return this.barrier.generation;
	}
	get state(): AdmissionState {
		return this.barrier.state;
	}
	admit(owner: string, generation = this.generation): () => void {
		return this.barrier.admit(owner, generation);
	}
	beginDrain(): MigrationControlSnapshot {
		this.barrier.beginDrain();
		return { generation: this.generation, state: this.state, blockers: this.blockers() };
	}
	blockers(): DrainBlockerReceipt[] {
		return this.barrier.receipts();
	}
	async close(): Promise<{ readonly closed: boolean; readonly blockers: DrainBlockerReceipt[] }> {
		const result = await this.barrier.waitForDrain(this.timeoutMs);
		return { closed: !result.timedOut, blockers: result.blockers };
	}
	reopen(generation: string): MigrationControlSnapshot {
		if (!generation || generation === this.generation) throw new Error("reopen requires a new generation");
		if (this.state !== "closed") throw new Error("migration control must be closed before reopening");
		this.barrier = new WorkspaceAdmissionBarrier(generation, this.timeoutMs);
		return { generation, state: this.state, blockers: [] };
	}
}

export class MigrationWriterRegistry {
	private readonly entries = new Map<string, WorkspaceAdmissionBarrier>();
	register(owner: string, barrier: WorkspaceAdmissionBarrier): () => void {
		if (this.entries.has(owner)) throw new Error(`writer already registered: ${owner}`);
		this.entries.set(owner, barrier);
		return () => {
			if (this.entries.get(owner) === barrier) this.entries.delete(owner);
		};
	}
	owners(): string[] {
		return [...this.entries.keys()].sort();
	}
	async drainAll(): Promise<DrainBlockerReceipt[]> {
		const results = await Promise.all([...this.entries.values()].map((barrier) => barrier.waitForDrain()));
		return results.flatMap((result) => result.blockers);
	}
}

export interface MigrationLeaseMetadata {
	workspace: string;
	generation: string;
	journal?: string;
	pid?: number;
}
export class MigrationLease {
	private constructor(
		private readonly path: string,
		private readonly fd: number,
	) {}
	static async acquire(path: string, metadata: MigrationLeaseMetadata): Promise<MigrationLease> {
		if (!metadata.workspace || !metadata.generation) throw new Error("workspace and generation are required");
		mkdirSync(dirname(path), { recursive: true });
		let fd: number;
		try {
			fd = openSync(path, "wx", 0o600);
		} catch (error) {
			throw new Error(`migration lease is already held: ${path}`, { cause: error });
		}
		const record = { ...metadata, pid: metadata.pid ?? process.pid, acquiredAt: new Date().toISOString() };
		try {
			writeFileSync(fd, JSON.stringify(record), { encoding: "utf8" });
		} catch (error) {
			closeSync(fd);
			unlinkSync(path);
			throw error;
		}
		return new MigrationLease(path, fd);
	}
	async release(): Promise<void> {
		closeSync(this.fd);
		try {
			unlinkSync(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	static inspect(path: string): (MigrationLeaseMetadata & { pid: number; acquiredAt: string }) | undefined {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	}
}
