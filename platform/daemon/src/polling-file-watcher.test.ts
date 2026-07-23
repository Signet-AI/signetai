import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PollingFileWatcher, startPollingFileWatcher } from "./polling-file-watcher";

const dirs: string[] = [];
const watchers: PollingFileWatcher[] = [];

afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("polling file watcher", () => {
	it("reports bounded add, change, and unlink events without recursive watches", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-poll-watch-"));
		dirs.push(dir);
		const path = join(dir, "agent.yaml");
		const events: string[] = [];
		const watcher = await startPollingFileWatcher({
			paths: [path],
			intervalMs: 10,
			onError(error) {
				throw error;
			},
			onEvent(event) {
				events.push(event);
			},
		});
		watchers.push(watcher);

		writeFileSync(path, "version: 1\n");
		await Bun.sleep(30);
		writeFileSync(path, "version: 22\n");
		await Bun.sleep(30);
		unlinkSync(path);
		await Bun.sleep(30);

		expect(events).toEqual(["add", "change", "unlink"]);
	});
});
