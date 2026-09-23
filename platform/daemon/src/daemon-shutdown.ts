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

export async function closeDbOwnerDuringShutdown(
	closeMaintenance: () => Promise<void>,
	closeOwner: () => Promise<void>,
): Promise<void> {
	let maintenanceClose: Promise<void>;
	try {
		maintenanceClose = closeMaintenance();
	} catch (error) {
		maintenanceClose = Promise.reject(error);
	}

	let ownerClose: Promise<void>;
	try {
		ownerClose = closeOwner();
	} catch (error) {
		ownerClose = Promise.reject(error);
	}

	const [maintenanceResult, ownerResult] = await Promise.allSettled([maintenanceClose, ownerClose]);
	if (ownerResult.status === "rejected") throw ownerResult.reason;
	if (maintenanceResult.status === "rejected") throw maintenanceResult.reason;
}
