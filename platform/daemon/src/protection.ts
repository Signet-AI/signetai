import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
	aggregateProtection,
	PROTECTION_COMPONENT_IDS,
	type ProtectionComponent,
	type ProtectionStatus,
} from "@signet/core";
import type { Hono } from "hono";
export interface RestoreReceipt {
	readonly at: string;
	readonly valid: boolean;
	readonly id?: string;
}
export interface ProtectionRouteOptions {
	readonly components?: readonly ProtectionComponent[];
	readonly workspacePath?: string;
	readonly restoreReceipt?: RestoreReceipt | null;
}
export function saveRestoreReceipt(root: string, receipt: RestoreReceipt): void {
	const dir = join(root, ".daemon");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `.protection-restore-receipt.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	renameSync(tmp, join(dir, "protection-restore-receipt.json"));
}
export function readRestoreReceipt(root: string): RestoreReceipt | null {
	try {
		const value = JSON.parse(
			readFileSync(join(root, ".daemon", "protection-restore-receipt.json"), "utf8"),
		) as RestoreReceipt;
		return typeof value.at === "string" && value.valid === true ? value : null;
	} catch {
		return null;
	}
}
export function mountProtectionRoutes(app: Hono, options: ProtectionRouteOptions = {}): void {
	app.get("/api/protection", (c) => {
		const components =
			options.components ??
			PROTECTION_COMPONENT_IDS.map((id) => ({
				id,
				type: "unknown",
				authority: "unknown" as const,
				location: "unknown",
				mechanism: "unknown",
				state: "unknown" as const,
				required: true,
				intentionallyExcluded: false,
				reason: "not checked",
			}));
		const status: ProtectionStatus = aggregateProtection(components);
		return c.json(status);
	});
}
