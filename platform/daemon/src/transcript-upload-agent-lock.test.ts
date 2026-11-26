import { describe, expect, it } from "bun:test";
import { transcriptUploadAgentExclusiveHolds, withTranscriptUploadAgentLock } from "./transcript-upload-agent-lock";

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
	let open = (): void => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

describe("transcript upload agent lock", () => {
	it("runs shared holders of one agent together", async () => {
		const events: string[] = [];
		const first = gate();
		const a = withTranscriptUploadAgentLock("noam", "shared", async () => {
			events.push("a start");
			await first.opened;
			events.push("a end");
		});
		const b = withTranscriptUploadAgentLock("noam", "shared", async () => {
			events.push("b");
		});
		await b;
		first.open();
		await a;
		expect(events).toEqual(["a start", "b", "a end"]);
	});

	it("starts an exclusive holder after every shared holder ends", async () => {
		const events: string[] = [];
		const upload = gate();
		const shared = withTranscriptUploadAgentLock("noam", "shared", async () => {
			events.push("upload start");
			await upload.opened;
			events.push("upload end");
		});
		const exclusive = withTranscriptUploadAgentLock("noam", "exclusive", async () => {
			events.push("purge");
		});
		upload.open();
		await Promise.all([shared, exclusive]);
		expect(events).toEqual(["upload start", "upload end", "purge"]);
	});

	it("queues a shared holder behind a waiting exclusive holder", async () => {
		const events: string[] = [];
		const upload = gate();
		const first = withTranscriptUploadAgentLock("noam", "shared", async () => {
			await upload.opened;
			events.push("first upload");
		});
		const purge = withTranscriptUploadAgentLock("noam", "exclusive", async () => {
			events.push("purge");
		});
		const later = withTranscriptUploadAgentLock("noam", "shared", async () => {
			events.push("later upload");
		});
		upload.open();
		await Promise.all([first, purge, later]);
		expect(events).toEqual(["first upload", "purge", "later upload"]);
	});

	it("keeps agents apart", async () => {
		const events: string[] = [];
		const upload = gate();
		const shared = withTranscriptUploadAgentLock("noam", "shared", async () => {
			await upload.opened;
			events.push("noam upload");
		});
		await withTranscriptUploadAgentLock("ada", "exclusive", async () => {
			events.push("ada purge");
		});
		upload.open();
		await shared;
		expect(events).toEqual(["ada purge", "noam upload"]);
	});

	it("counts each finished exclusive hold per agent before a waiting shared holder runs", async () => {
		const before = transcriptUploadAgentExclusiveHolds("noam");
		const seen: number[] = [];
		const purge = gate();
		const exclusive = withTranscriptUploadAgentLock("noam", "exclusive", () => purge.opened);
		const waited = withTranscriptUploadAgentLock("noam", "shared", async () => {
			seen.push(transcriptUploadAgentExclusiveHolds("noam") - before);
		});
		purge.open();
		await Promise.all([exclusive, waited]);
		expect(seen).toEqual([1]);
		expect(transcriptUploadAgentExclusiveHolds("ada-never-purged")).toBe(0);
	});

	it("releases the lock and counts the hold when the exclusive holder throws", async () => {
		const before = transcriptUploadAgentExclusiveHolds("noam");
		await expect(
			withTranscriptUploadAgentLock("noam", "exclusive", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(transcriptUploadAgentExclusiveHolds("noam") - before).toBe(1);
		expect(await withTranscriptUploadAgentLock("noam", "shared", async () => "ran")).toBe("ran");
	});
});
