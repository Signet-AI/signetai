import { mkdir, readdir, unlink } from "node:fs/promises";
import { resolveWorkspaceLayout } from "@signet/core";
import { scanInbox, type ImportLedger, type ImportRow } from "./import-inbox";

export interface ManualInboxWorkerOptions {
	readonly root: string;
	readonly ledger?: ImportLedger;
	/** Compatibility adapter for callers that own admission but not lifecycle. */
	readonly admission?: { admit(input: { fileName: string; bytes: Uint8Array }): Promise<ImportRow> };
	readonly dispatchDocument?: (row: ImportRow) => Promise<void>;
	readonly dispatchTranscript?: (row: ImportRow) => Promise<void>;
	readonly pollMs?: number;
	readonly maxFiles?: number;
	readonly settleMs?: number;
	/** Existing visible files are inert unless the operator explicitly opts in. */
	readonly enableExisting?: boolean;
}
export interface ManualInboxWorkerHandle {
	readonly running: boolean;
	stop(): Promise<void>;
	nudge(): void;
}

/**
 * Production owner of the manual `files/` ingress. Admission, retention, and
 * lifecycle state remain owned by the durable import ledger; this worker only
 * inventories a bounded batch and dispatches admitted records.
 */
export function startManualInboxWorker(options: ManualInboxWorkerOptions): ManualInboxWorkerHandle {
	let active = true;
	let wake: (() => void) | undefined;
	let loop: Promise<void>;
	let enabled = false;
	const layout = resolveWorkspaceLayout(options.root);
	const wait = () =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(
				() => {
					wake = undefined;
					resolve();
				},
				Math.max(10, options.pollMs ?? 250),
			);
			wake = () => {
				clearTimeout(timer);
				wake = undefined;
				resolve();
			};
		});
	const dispatch = async (row: ImportRow): Promise<void> => {
		const handler = row.fileName.toLowerCase().endsWith(".jsonl")
			? options.dispatchTranscript
			: options.dispatchDocument;
		if (!handler) throw new Error(`no importer configured for ${row.fileName}`);
		await handler(row);
		await options.ledger?.transition?.(row.key, "processing", "imported");
	};
	const tick = async (): Promise<void> => {
		if (!enabled) {
			await mkdir(layout.files, { recursive: true });
			const entries = await readdir(layout.files, { withFileTypes: true });
			const visible = entries.some(
				(entry) => !entry.name.startsWith(".") && !entry.name.endsWith(".part") && !entry.name.endsWith(".tmp"),
			);
			if (visible && !options.enableExisting) return;
			enabled = true;
		}
		if (!options.ledger && options.admission) {
			for (const entry of await readdir(layout.files, { withFileTypes: true })) {
				if (!entry.isFile() || entry.name.endsWith(".part") || entry.name.endsWith(".tmp")) continue;
				const path = `${layout.files}/${entry.name}`;
				const row = await options.admission.admit({
					fileName: entry.name,
					bytes: new Uint8Array(await Bun.file(path).arrayBuffer()),
				});
				await dispatch(row);
				await unlink(path);
			}
			return;
		}
		if (!options.ledger) return;
		const rows = await scanInbox({
			root: layout.root,
			layout,
			ledger: options.ledger,
			maxFiles: options.maxFiles ?? 10,
			maxFileBytes: 25 * 1024 * 1024,
		});
		for (const row of rows) {
			if (!active) return;
			if (row.status !== "pending") continue;
			await options.ledger.transition?.(row.key, "pending", "processing");
			try {
				await dispatch({ ...row, status: "processing" });
			} catch (error) {
				await options.ledger.transition?.(
					row.key,
					"processing",
					"failed",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	};
	const run = async () => {
		while (active) {
			await tick();
			if (active) await wait();
		}
	};
	loop = run();
	return {
		get running() {
			return active;
		},
		nudge: () => wake?.(),
		stop: async () => {
			active = false;
			wake?.();
			await loop;
		},
	};
}
