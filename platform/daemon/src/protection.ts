import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	aggregateProtection,
	PROTECTION_COMPONENT_IDS,
	type ProtectionComponent,
	type RestoreReceipt,
} from "@signet/core";
import type { Hono } from "hono";

export interface ProtectionRouteOptions {
	readonly components?: readonly ProtectionComponent[];
	readonly restoreReceipt?: RestoreReceipt | null;
	readonly workspacePath?: string;
}

const receiptFile = (workspacePath: string): string =>
	join(workspacePath, ".daemon", "protection-restore-receipt.json");

export function saveRestoreReceipt(workspacePath: string, receipt: RestoreReceipt): void {
	const dir = join(workspacePath, ".daemon");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(receiptFile(workspacePath), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

export function readRestoreReceipt(workspacePath: string): RestoreReceipt | null {
	try {
		const parsed = JSON.parse(readFileSync(receiptFile(workspacePath), "utf8")) as RestoreReceipt;
		return typeof parsed.at === "string" && parsed.valid === true ? parsed : null;
	} catch {
		return null;
	}
}

function safeComponent(component: ProtectionComponent): Omit<ProtectionComponent, "label"> {
	const { label: _label, ...safe } = component;
	return safe;
}

export function mountProtectionRoutes(app: Hono, options: ProtectionRouteOptions = {}): void {
	app.get("/api/protection", (c) => {
		const components =
			options.components ??
			PROTECTION_COMPONENT_IDS.map((id) => ({ id, status: "unknown" as const, detail: "not checked" }));
		const receipt =
			options.restoreReceipt ?? (options.workspacePath ? readRestoreReceipt(options.workspacePath) : null);
		const status = aggregateProtection(components, { restoreReceipt: receipt });
		return c.json({ ...status, components: status.components.map(safeComponent) });
	});
}
