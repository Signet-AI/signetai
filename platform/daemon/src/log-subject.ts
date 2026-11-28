import { AsyncLocalStorage } from "node:async_hooks";

export interface LogSubject {
	readonly agentId: string;
	readonly compartmentId: number | null | "unresolved";
	readonly sessionKey?: string;
}

const subjects = new AsyncLocalStorage<LogSubject>();
export function withLogSubject<T>(subject: LogSubject | undefined, operation: () => T): T {
	return subject ? subjects.run(subject, operation) : operation();
}
export function currentLogSubject(): LogSubject | undefined {
	return subjects.getStore();
}
