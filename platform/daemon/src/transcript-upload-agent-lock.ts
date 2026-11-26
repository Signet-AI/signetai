interface Waiter {
	readonly exclusive: boolean;
	readonly grant: () => void;
}

interface Gate {
	readers: number;
	writer: boolean;
	readonly queue: Waiter[];
}

const gates = new Map<string, Gate>();
const finishedExclusiveHolds = new Map<string, number>();

function pump(gate: Gate): void {
	while (!gate.writer) {
		const next = gate.queue[0];
		if (!next || (next.exclusive && gate.readers > 0)) return;
		gate.queue.shift();
		if (next.exclusive) gate.writer = true;
		else gate.readers += 1;
		next.grant();
	}
}

export class TranscriptUploadAdmission {
	readonly agentId: string;
	readonly #purges: number;

	private constructor(agentId: string) {
		this.agentId = agentId;
		this.#purges = finishedExclusiveHolds.get(agentId) ?? 0;
	}

	static admit(agentId: string): TranscriptUploadAdmission {
		return new TranscriptUploadAdmission(agentId);
	}

	purgedSince(): boolean {
		return (finishedExclusiveHolds.get(this.agentId) ?? 0) !== this.#purges;
	}
}

export async function withTranscriptUploadAgentLock<Result>(
	agentId: string,
	mode: "shared" | "exclusive",
	operation: () => Promise<Result>,
): Promise<Result> {
	const gate = gates.get(agentId) ?? { readers: 0, writer: false, queue: [] };
	gates.set(agentId, gate);
	const exclusive = mode === "exclusive";
	await new Promise<void>((grant) => {
		gate.queue.push({ exclusive, grant });
		pump(gate);
	});
	try {
		return await operation();
	} finally {
		if (exclusive) {
			gate.writer = false;
			finishedExclusiveHolds.set(agentId, (finishedExclusiveHolds.get(agentId) ?? 0) + 1);
		} else gate.readers -= 1;
		pump(gate);
		if (!gate.writer && gate.readers === 0 && gate.queue.length === 0) gates.delete(agentId);
	}
}
