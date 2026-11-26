import { describe, expect, it } from "bun:test";
import { withTranscriptUploadAgentLock } from "./transcript-upload-agent-lock";

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

	it("tells a shared holder whether an exclusive holder ran while it waited", async () => {
		const seen: boolean[] = [];
		const purge = gate();
		const exclusive = withTranscriptUploadAgentLock("noam", "exclusive", () => purge.opened);
		const waited = withTranscriptUploadAgentLock("noam", "shared", async (preempted) => {
			seen.push(preempted);
		});
		purge.open();
		await Promise.all([exclusive, waited]);
		await withTranscriptUploadAgentLock("noam", "shared", async (preempted) => {
			seen.push(preempted);
		});
		expect(seen).toEqual([true, false]);
	});

	it("releases the lock when the holder throws", async () => {
		await expect(
			withTranscriptUploadAgentLock("noam", "exclusive", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await withTranscriptUploadAgentLock("noam", "shared", async () => "ran")).toBe("ran");
	});
});
