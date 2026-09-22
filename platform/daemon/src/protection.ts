import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
import {
	aggregateProtection,
	buildProtectionEvidence,
	PROTECTION_COMPONENT_IDS,
	type ProtectionComponent,
	type ProtectionStatus,
} from "@signet/core";
import type { Hono } from "hono";

export interface RestoreReceipt {
	readonly at: string;
	readonly valid: boolean;
	readonly id?: string;
	readonly scope?: string;
}

export interface ProtectionRouteOptions {
	readonly components?: readonly ProtectionComponent[];
	readonly workspacePath?: string;
	readonly restoreReceipt?: RestoreReceipt | null;
	readonly externalKeyringAvailable?: boolean;
}

const receiptFile = (workspacePath: string): string =>
	join(resolveWorkspaceLayout(workspacePath).runtime, "protection-restore-receipt.json");

export function saveRestoreReceipt(workspacePath: string, receipt: RestoreReceipt): void {
	const dir = resolveWorkspaceLayout(workspacePath).runtime;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `.protection-restore-receipt.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	renameSync(tmp, receiptFile(workspacePath));
}

export function readRestoreReceipt(workspacePath: string): RestoreReceipt | null {
	try {
		const value = JSON.parse(readFileSync(receiptFile(workspacePath), "utf8")) as RestoreReceipt;
		return typeof value.at === "string" && value.valid === true ? value : null;
	} catch {
		return null;
	}
}

function unknownComponents(): ProtectionComponent[] {
	return PROTECTION_COMPONENT_IDS.map(
		(id): ProtectionComponent => ({
			id,
			type: id,
			authority: "unknown" as const,
			location: "[redacted]",
			mechanism: "unknown",
			state: "unknown" as const,
			required: id !== "runtime" && id !== "filesystem-cache",
			intentionallyExcluded: id === "runtime" || id === "filesystem-cache",
			reason: "not checked",
		}),
	);
}

export function mountProtectionRoutes(app: Hono, options: ProtectionRouteOptions = {}): void {
	app.get("/api/protection", (c) => {
		const receipt =
			options.restoreReceipt ?? (options.workspacePath ? readRestoreReceipt(options.workspacePath) : null);
		const components =
			options.components ??
			(options.workspacePath
				? buildProtectionEvidence(options.workspacePath, {
						externalKeyringAvailable: options.externalKeyringAvailable,
						restoreVerifiedAt: receipt?.valid ? receipt.at : undefined,
						verifiedScope: receipt?.scope,
					}).components
				: unknownComponents());
		const status: ProtectionStatus = aggregateProtection(components);
		return c.json(status);
	});
}
