import type { Context } from "hono";

declare module "hono" {
	interface ContextVariableMap {
		readAuditAgent: string | undefined;
		readAuditCount: number | null;
	}
}
export function reportReadResult(c: Context, agentId: string, count: number | null): void {
	c.set("readAuditAgent", agentId);
	c.set("readAuditCount", count);
}
