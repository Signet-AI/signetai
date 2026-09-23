import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export type ManualInboxRow = {
	key: string;
	fileName: string;
	originalPath: string;
	bytes?: Uint8Array;
	status: "processing" | "imported" | "duplicate" | "failed" | "quarantined";
	sourceId?: string;
	error?: string;
};
export type ManualInboxDispatchResult = {
	readonly status: "imported" | "duplicate";
	readonly sourceId: string;
};
export interface ManualInboxAdmission {
	isEnabled(): Promise<boolean>;
	enable(): Promise<void>;
	claim(input: {
		key: string;
		fileName: string;
		originalPath: string;
		bytes: Uint8Array;
	}): Promise<ManualInboxRow | null>;
	record(row: ManualInboxRow): Promise<void>;
	reconcile?(): Promise<void>;
}
export interface ManualInboxWorkerOptions {
	root: string;
	inboxPath?: string;
	admission: ManualInboxAdmission;
	dispatchTranscript?: (row: ManualInboxRow) => Promise<ManualInboxDispatchResult>;
	dispatchDocument?: (row: ManualInboxRow) => Promise<ManualInboxDispatchResult>;
	pollMs?: number;
	settleMs?: number;
	maxFiles?: number;
}
export interface ManualInboxWorkerHandle {
	readonly running: boolean;
	stop(): Promise<void>;
	nudge(): void;
	status(): { scanned: number; imported: number; failed: number; quarantined: number };
}

const hash = (bytes: Uint8Array, name: string) =>
	createHash("sha256").update(bytes).update("\0").update(name).digest("hex");
const temporary = (name: string) =>
	name.startsWith(".") || name.endsWith(".part") || name.endsWith(".tmp") || name.endsWith(".crdownload");

export function startManualInboxWorker(options: ManualInboxWorkerOptions): ManualInboxWorkerHandle {
	let active = true;
	let wake: (() => void) | undefined;
	let loop: Promise<void>;
	const counts = { scanned: 0, imported: 0, failed: 0, quarantined: 0 };
	const wait = () =>
		new Promise<void>((resolveWait) => {
			const timer = setTimeout(
				() => {
					wake = undefined;
					resolveWait();
				},
				Math.max(10, options.pollMs ?? 1000),
			);
			wake = () => {
				clearTimeout(timer);
				wake = undefined;
				resolveWait();
			};
		});
	const tick = async () => {
		const inbox = resolve(options.inboxPath ?? join(resolve(options.root), "files"));
		await mkdir(inbox, { recursive: true });
		const names = (await readdir(inbox)).filter((name) => !temporary(name)).slice(0, options.maxFiles ?? 10);
		const enabled = await options.admission.isEnabled();
		// An existing inbox is inert by default. Only an empty inbox establishes the opt-in marker.
		if (!enabled) {
			if (names.length === 0) await options.admission.enable();
			else return;
		}
		for (const fileName of names) {
			if (!active) return;
			counts.scanned++;
			const path = join(inbox, fileName);
			const before = await lstat(path).catch(() => null);
			if (!before) continue;
			if ((options.settleMs ?? 50) > 0)
				await new Promise((resolveWait) => setTimeout(resolveWait, options.settleMs ?? 50));
			if (!active) return;
			if (!before.isFile()) {
				counts.quarantined++;
				await options.admission.record({
					key: `quarantine:${fileName}`,
					fileName,
					originalPath: path,
					status: "quarantined",
					error: "not a regular file",
				});
				continue;
			}
			const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
			const after = await lstat(path).catch(() => null);
			if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue;
			const claimed = await options.admission.claim({
				key: hash(bytes, fileName),
				fileName,
				originalPath: path,
				bytes,
			});
			if (!claimed) continue;
			if (claimed.status === "imported" || claimed.status === "duplicate") {
				await unlink(path).catch(() => {});
				continue;
			}
			try {
				const dispatch = fileName.endsWith(".jsonl") ? options.dispatchTranscript : options.dispatchDocument;
				if (!dispatch) throw new Error("no dispatcher configured");
				const result = await dispatch(claimed);
				await options.admission.record({ ...claimed, status: result.status, sourceId: result.sourceId });
				await unlink(path).catch((error) => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				});
				counts.imported++;
			} catch (error) {
				await options.admission.record({
					...claimed,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
				counts.failed++;
			}
		}
	};
	const run = async () => {
		await options.admission.reconcile?.();
		while (active) {
			try {
				await tick();
			} catch {}
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
		status: () => ({ ...counts }),
	};
}
