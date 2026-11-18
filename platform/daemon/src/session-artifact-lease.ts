import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeSessionKey } from "./session-end-state";

interface Lease {
	tail: Promise<void>;
	readonly readers: Set<Promise<void>>;
	pending: number;
}

const leases = new Map<string, Lease>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

export class SessionArtifactLeaseTimeoutError extends Error {
	constructor() {
		super("Session artifact lease deadline exceeded");
		this.name = "SessionArtifactLeaseTimeoutError";
	}
}

export async function withSessionArtifactLease<T>(
	input: { readonly agentId: string; readonly sessionKey: string | null; readonly sessionId?: string },
	exclusive: boolean,
	work: () => Promise<T>,
): Promise<T> {
	const key = JSON.stringify([input.agentId, normalizeSessionKey(input.sessionKey ?? input.sessionId ?? "")]);
	if (!exclusive && held.getStore()?.has(key)) return work();
	const lease = leases.get(key) ?? { tail: Promise.resolve(), readers: new Set<Promise<void>>(), pending: 0 };
	leases.set(key, lease);
	lease.pending++;
	const done = Promise.withResolvers<void>();
	const ready = exclusive ? Promise.all([lease.tail, ...lease.readers]) : lease.tail;
	if (exclusive) lease.tail = ready.then(() => done.promise);
	if (!exclusive) lease.readers.add(done.promise);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			ready,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new SessionArtifactLeaseTimeoutError()), 15_000);
			}),
		]);
		clearTimeout(timer);
		return await held.run(new Set([...(held.getStore() ?? []), key]), work);
	} finally {
		clearTimeout(timer);
		done.resolve();
		lease.readers.delete(done.promise);
		if (--lease.pending === 0) leases.delete(key);
	}
}
