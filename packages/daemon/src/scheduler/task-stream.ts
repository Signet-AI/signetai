export type TaskStreamEvent =
	| {
			readonly type: "connected";
			readonly taskId: string;
			readonly timestamp: string;
	  }
	| {
			readonly type: "run-started";
			readonly taskId: string;
			readonly runId: string;
			readonly startedAt: string;
			readonly timestamp: string;
	  }
	| {
			readonly type: "run-output";
			readonly taskId: string;
			readonly runId: string;
			readonly stream: "stdout" | "stderr";
			readonly chunk: string;
			readonly timestamp: string;
	  }
	| {
			readonly type: "run-completed";
			readonly taskId: string;
			readonly runId: string;
			readonly status: "completed" | "failed";
			readonly completedAt: string;
			readonly exitCode: number | null;
			readonly error: string | null;
			readonly timestamp: string;
	  };

type TaskStreamListener = (event: TaskStreamEvent) => void;

interface RunningTaskStreamState {
	readonly runId: string;
	readonly startedAt: string;
	readonly stdoutChunks: string[];
	readonly stderrChunks: string[];
	stdoutChars: number;
	stderrChars: number;
}

export interface TaskStreamReplaySnapshot {
	readonly runId: string;
	readonly startedAt: string;
	readonly stdoutChunks: ReadonlyArray<string>;
	readonly stderrChunks: ReadonlyArray<string>;
}

const listenersByTaskId = new Map<string, Set<TaskStreamListener>>();
const runningByTaskId = new Map<string, RunningTaskStreamState>();

const MAX_BUFFER_CHARS_PER_STREAM = 200_000;

function appendChunk(
	chunks: string[],
	currentChars: number,
	chunk: string,
): number {
	if (chunk.length === 0) return currentChars;

	chunks.push(chunk);
	let nextChars = currentChars + chunk.length;

	while (nextChars > MAX_BUFFER_CHARS_PER_STREAM && chunks.length > 0) {
		const first = chunks[0];
		if (!first) break;

		if (nextChars - first.length >= MAX_BUFFER_CHARS_PER_STREAM) {
			chunks.shift();
			nextChars -= first.length;
			continue;
		}

		const overflow = nextChars - MAX_BUFFER_CHARS_PER_STREAM;
		chunks[0] = first.slice(overflow);
		nextChars -= overflow;
		break;
	}

	return nextChars;
}

export function subscribeTaskStream(
	taskId: string,
	listener: TaskStreamListener,
): () => void {
	const existing = listenersByTaskId.get(taskId);
	if (existing) {
		existing.add(listener);
	} else {
		listenersByTaskId.set(taskId, new Set([listener]));
	}

	return () => {
		const listeners = listenersByTaskId.get(taskId);
		if (!listeners) return;
		listeners.delete(listener);
		if (listeners.size === 0) {
			listenersByTaskId.delete(taskId);
		}
	};
}

export function getTaskStreamSnapshot(
	taskId: string,
): TaskStreamReplaySnapshot | null {
	const running = runningByTaskId.get(taskId);
	if (!running) return null;

	return {
		runId: running.runId,
		startedAt: running.startedAt,
		stdoutChunks: [...running.stdoutChunks],
		stderrChunks: [...running.stderrChunks],
	};
}

export function emitTaskStream(event: TaskStreamEvent): void {
	if (event.type === "run-started") {
		runningByTaskId.set(event.taskId, {
			runId: event.runId,
			startedAt: event.startedAt,
			stdoutChunks: [],
			stderrChunks: [],
			stdoutChars: 0,
			stderrChars: 0,
		});
	} else if (event.type === "run-output") {
		const running = runningByTaskId.get(event.taskId);
		if (running && running.runId === event.runId) {
			if (event.stream === "stdout") {
				running.stdoutChars = appendChunk(
					running.stdoutChunks,
					running.stdoutChars,
					event.chunk,
				);
			} else {
				running.stderrChars = appendChunk(
					running.stderrChunks,
					running.stderrChars,
					event.chunk,
				);
			}
		}
	} else if (event.type === "run-completed") {
		const running = runningByTaskId.get(event.taskId);
		if (running && running.runId === event.runId) {
			runningByTaskId.delete(event.taskId);
		}
	}

	const listeners = listenersByTaskId.get(event.taskId);
	if (!listeners || listeners.size === 0) return;

	for (const listener of listeners) {
		listener(event);
	}
}
