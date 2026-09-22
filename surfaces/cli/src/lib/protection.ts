import type { ProtectionStatus } from "@signet/core";

export function projectProtectionStatus(payload: ProtectionStatus): {
	readonly status: ProtectionStatus["status"];
	readonly protected: boolean;
	readonly components: ProtectionStatus["components"];
} {
	return {
		status: payload.status,
		protected: payload.protected,
		components: payload.components,
	};
}

export function formatProtectionLine(status: Pick<ProtectionStatus, "status" | "protected">): string {
	return `Protection: ${status.protected ? "protected" : status.status}`;
}
