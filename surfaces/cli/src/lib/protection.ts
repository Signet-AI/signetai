import type { ProtectionStatus } from "@signet/core";
export function projectProtectionStatus(payload: ProtectionStatus): ProtectionStatus {
	return payload;
}
export function formatProtectionLine(status: Pick<ProtectionStatus, "overall">): string {
	return `Protection: ${status.overall}`;
}
