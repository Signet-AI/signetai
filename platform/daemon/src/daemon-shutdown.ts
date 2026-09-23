export interface ShutdownRequest {
	readonly reason: string;
	readonly exitCode: number;
}

export interface ShutdownRequestGate {
	readonly primary: ShutdownRequest | null;
	begin(request: ShutdownRequest): boolean;
}

export function createShutdownRequestGate(): ShutdownRequestGate {
	let primary: ShutdownRequest | null = null;
	return {
		get primary(): ShutdownRequest | null {
			return primary;
		},
		begin(request): boolean {
			if (primary !== null) return false;
			primary = request;
			return true;
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
