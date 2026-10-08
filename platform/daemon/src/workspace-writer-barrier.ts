export type AdmissionState = "open" | "draining" | "closed";

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

export class WriterLease {
	private released = false;
	constructor(
		private readonly control: MigrationControlBoundary,
		readonly generation: string,
		private readonly releaseAdmission: () => void,
	) {}
	assertCurrent(): void {
		this.control.assertCurrent(this.generation);
	}
	release(): void {
		if (this.released) return;
		this.released = true;
		this.releaseAdmission();
	}
}

export interface MigrationControlSnapshot {
	readonly generation: string;
	readonly state: AdmissionState;
	readonly blockers: DrainBlockerReceipt[];
}
export class MigrationControlBoundary {
	private readonly barrier: WorkspaceAdmissionBarrier;
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
	acquireWriter(owner: string, generation = this.generation): WriterLease {
		const release = this.admit(owner, generation);
		return new WriterLease(this, generation, release);
	}
	assertCurrent(generation: string): void {
		if (generation !== this.generation || this.state !== "open") {
			throw new WorkspaceMigrationRetryableError("stale-writer", this.generation);
		}
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
}
