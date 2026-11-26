import { describe, expect, it } from "bun:test";
import { TranscriptUploadAdmission, withTranscriptUploadAgentLock } from "./transcript-upload-agent-lock";

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

	it("marks an admission once an exclusive hold of its agent finishes", async () => {
		const admission = TranscriptUploadAdmission.admit("noam");
		const other = TranscriptUploadAdmission.admit("ada");
		const seen: boolean[] = [];
		const purge = gate();
		const exclusive = withTranscriptUploadAgentLock("noam", "exclusive", () => purge.opened);
		const waited = withTranscriptUploadAgentLock("noam", "shared", async () => {
			seen.push(admission.purgedSince());
		});
		expect(admission.purgedSince()).toBe(false);
		purge.open();
		await Promise.all([exclusive, waited]);
		expect(seen).toEqual([true]);
		expect(other.purgedSince()).toBe(false);
		expect(TranscriptUploadAdmission.admit("noam").purgedSince()).toBe(false);
	});

	it("releases the lock and counts the hold when the exclusive holder throws", async () => {
		const admission = TranscriptUploadAdmission.admit("noam");
		await expect(
			withTranscriptUploadAgentLock("noam", "exclusive", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(admission.purgedSince()).toBe(true);
		expect(await withTranscriptUploadAgentLock("noam", "shared", async () => "ran")).toBe("ran");
	});
});
