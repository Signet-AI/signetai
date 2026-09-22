export interface DbAccessorCloseParticipant {
	readonly name: string;
	readonly order: number;
	close(dbPath: string | undefined): void | Promise<void>;
}

export interface DbAccessorLifecycle {
	register(participant: DbAccessorCloseParticipant): void;
	close(dbPath: string | undefined): Promise<void>;
}
export function createDbAccessorLifecycle(): DbAccessorLifecycle {
	const closeParticipants = new Map<string, DbAccessorCloseParticipant>();
	let closeStarted = false;
	let closePromise: Promise<void> | undefined;

	return {
		register(participant: DbAccessorCloseParticipant): void {
			if (closeStarted) {
				throw new Error(`DB accessor close participant registered after close started: ${participant.name}`);
			}
			if (closeParticipants.has(participant.name)) {
				throw new Error(`DB accessor close participant already registered: ${participant.name}`);
			}
			closeParticipants.set(participant.name, participant);
		},

		close(dbPath: string | undefined): Promise<void> {
			if (closePromise !== undefined) return closePromise;
			closeStarted = true;
			const participants = [...closeParticipants.values()].sort(
				(left, right) => left.order - right.order || left.name.localeCompare(right.name),
			);
			let resolveClose!: () => void;
			let rejectClose!: (reason?: unknown) => void;
			const pendingClose = new Promise<void>((resolve, reject) => {
				resolveClose = resolve;
				rejectClose = reject;
			});
			closePromise = pendingClose;
			void (async () => {
				try {
					for (const participant of participants) await participant.close(dbPath);
					resolveClose();
				} catch (error) {
					rejectClose(error);
				} finally {
					closeStarted = false;
					closePromise = undefined;
				}
			})();
			return pendingClose;
		},
	};
}

const defaultLifecycle = createDbAccessorLifecycle();

export function registerDbAccessorCloseParticipant(participant: DbAccessorCloseParticipant): void {
	defaultLifecycle.register(participant);
}
export async function closeDbAccessorParticipants(dbPath: string | undefined): Promise<void> {
	await defaultLifecycle.close(dbPath);
}
