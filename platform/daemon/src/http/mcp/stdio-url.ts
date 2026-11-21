import { resolveSignetDaemonUrl } from "@signet/core";

export function resolveMcpDaemonUrl(env: Record<string, string | undefined> = process.env): string {
	return resolveSignetDaemonUrl({ env });
}
