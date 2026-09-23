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
