export interface ShutdownRequest {
	readonly reason: string;
	readonly exitCode: number;
}

export interface ShutdownRequestGate {
	readonly primary: ShutdownRequest | null;
	readonly fatalRequest: ShutdownRequest | null;
	readonly exitCode: number | null;
	begin(request: ShutdownRequest): "begin" | "ignore" | "fatal";
}

export function createShutdownRequestGate(): ShutdownRequestGate {
	let primary: ShutdownRequest | null = null;
	let fatalRequest: ShutdownRequest | null = null;
	let exitCode: number | null = null;
	return {
		get primary(): ShutdownRequest | null {
			return primary;
		},
		get fatalRequest(): ShutdownRequest | null {
			return fatalRequest;
		},
		get exitCode(): number | null {
			return exitCode;
		},
		begin(request): "begin" | "ignore" | "fatal" {
			if (primary !== null) {
				if (request.exitCode === 0) return "ignore";
				if (exitCode === 0) exitCode = request.exitCode;
				fatalRequest ??= request;
				return "fatal";
			}
			primary = request;
			exitCode = request.exitCode;
			if (request.exitCode !== 0) fatalRequest = request;
			return "begin";
		},
	};
}

export function forceExitDuringShutdownFlush(
	flushInFlight: Promise<void> | null,
	exitCode: number,
	flushLogs: () => void,
	exit: (exitCode: number) => void,
): boolean {
	if (flushInFlight === null || exitCode === 0) return false;
	flushLogs();
	exit(exitCode);
	return true;
}

export async function runShutdownCleanup(
	cleanup: () => Promise<void>,
	onSettled: (cleanupError: Error | null) => void,
): Promise<void> {
	let cleanupError: Error | null = null;
	try {
		await cleanup();
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}
	onSettled(cleanupError);
}

export interface DbOwnerShutdownOptions {
	readonly stopBackground: () => Promise<void>;
	readonly closeMaintenance: () => Promise<void>;
	readonly closeOwner: () => Promise<void>;
}

function startShutdownAction(action: () => Promise<void>): Promise<void> {
	try {
		return action();
	} catch (error) {
		return Promise.reject(error);
	}
}

export async function closeDbOwnerDuringShutdown(options: DbOwnerShutdownOptions): Promise<void> {
	const backgroundStop = startShutdownAction(options.stopBackground);
	const maintenanceClose = startShutdownAction(options.closeMaintenance);
	const ownerClose = startShutdownAction(options.closeOwner);
	const [backgroundResult, maintenanceResult, ownerResult] = await Promise.allSettled([
		backgroundStop,
		maintenanceClose,
		ownerClose,
	]);
	if (ownerResult.status === "rejected") throw ownerResult.reason;
	if (maintenanceResult.status === "rejected") throw maintenanceResult.reason;
	if (backgroundResult.status === "rejected") throw backgroundResult.reason;
}
