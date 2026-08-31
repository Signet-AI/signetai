import { describe, expect, it } from "bun:test";
import { withSetupPrompt } from "./setup-terminal.js";

function fakeSpinner(events: string[], spinning = true) {
	return {
		get isSpinning() {
			return spinning;
		},
		stop() {
			events.push("stop");
			spinning = false;
			return this;
		},
		start() {
			events.push("start");
			spinning = true;
			return this;
		},
	};
}

describe("setup prompt terminal ownership", () => {
	it("stops the spinner before rendering a prompt and resumes after it returns", async () => {
		const events: string[] = [];
		const spinner = fakeSpinner(events);

		const answer = await withSetupPrompt(spinner, async () => {
			expect(spinner.isSpinning).toBe(false);
			events.push("prompt");
			return "answer";
		});

		expect(answer).toBe("answer");
		expect(events).toEqual(["stop", "prompt", "start"]);
		expect(spinner.isSpinning).toBe(true);
	});

	it("keeps the spinner stopped for the whole prompt lifetime", async () => {
		const events: string[] = [];
		const spinner = fakeSpinner(events);
		let finishPrompt: (() => void) | undefined;
		const promptDone = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});

		const answerPromise = withSetupPrompt(spinner, async () => {
			events.push("prompt-start");
			await promptDone;
			events.push("prompt-end");
			return "answer";
		});
		await Promise.resolve();

		expect(spinner.isSpinning).toBe(false);
		expect(events).toEqual(["stop", "prompt-start"]);
		finishPrompt?.();
		await expect(answerPromise).resolves.toBe("answer");
		expect(events).toEqual(["stop", "prompt-start", "prompt-end", "start"]);
	});

	it("does not start a spinner that was already stopped", async () => {
		const events: string[] = [];
		const spinner = fakeSpinner(events, false);

		await withSetupPrompt(spinner, async () => {
			expect(spinner.isSpinning).toBe(false);
			events.push("prompt");
		});

		expect(events).toEqual(["prompt"]);
		expect(spinner.isSpinning).toBe(false);
	});

	it("restores spinner ownership after a prompt throws", async () => {
		const events: string[] = [];
		const spinner = fakeSpinner(events);
		const failure = new Error("prompt cancelled");

		await expect(
			withSetupPrompt(spinner, async () => {
				expect(spinner.isSpinning).toBe(false);
				events.push("prompt");
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(events).toEqual(["stop", "prompt", "start"]);
		expect(spinner.isSpinning).toBe(true);
	});
});
