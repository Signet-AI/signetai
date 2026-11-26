interface Waiter {
	readonly exclusive: boolean;
	preempted: boolean;
	readonly grant: (preempted: boolean) => void;
}

interface Gate {
	readers: number;
	writer: boolean;
	readonly queue: Waiter[];
}

const gates = new Map<string, Gate>();

function pump(gate: Gate): void {
	while (!gate.writer) {
		const next = gate.queue[0];
		if (!next || (next.exclusive && gate.readers > 0)) return;
		gate.queue.shift();
		if (next.exclusive) {
			gate.writer = true;
			for (const waiter of gate.queue) waiter.preempted = true;
		} else gate.readers += 1;
		next.grant(next.preempted);
	}
}

export async function withTranscriptUploadAgentLock<Result>(
	agentId: string,
	mode: "shared" | "exclusive",
	operation: (preempted: boolean) => Promise<Result>,
): Promise<Result> {
	const gate = gates.get(agentId) ?? { readers: 0, writer: false, queue: [] };
	gates.set(agentId, gate);
	const exclusive = mode === "exclusive";
	const preempted = await new Promise<boolean>((grant) => {
		gate.queue.push({ exclusive, preempted: gate.writer, grant });
		pump(gate);
	});
	try {
		return await operation(preempted);
	} finally {
		if (exclusive) gate.writer = false;
		else gate.readers -= 1;
		pump(gate);
		if (!gate.writer && gate.readers === 0 && gate.queue.length === 0) gates.delete(agentId);
	}
}
