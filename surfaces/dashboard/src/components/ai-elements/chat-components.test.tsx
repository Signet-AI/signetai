import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { PromptInput, PromptInputTextarea, PromptInputSubmit } from "./prompt-input";
import { MessageResponse } from "./message";
import { formatSourceReferences } from "./source-pill";
let dom: Window;
let restore = () => {};
beforeAll(() => {
	dom = new Window();
	restore = installDashboardDomGlobals(dom);
});
afterAll(() => {
	restore();
	dom.close();
});
describe("chat composer", () => {
	test("Enter sends, Shift+Enter and IME composition do not; generating stops without submitting", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		let submissions = 0;
		let stops = 0;
		async function render(generating: boolean, disabled = false) {
			await act(async () => {
				root.render(
					<PromptInput
						onSubmit={(event) => {
							event.preventDefault();
							submissions++;
						}}
					>
						<PromptInputTextarea aria-label="Message" />
						<PromptInputSubmit
							generating={generating}
							disabled={disabled}
							onStop={() => {
								stops++;
							}}
						/>
					</PromptInput>,
				);
			});
		}
		await render(false);
		const textarea = container.querySelector("textarea");
		if (!textarea) throw new Error("Composer missing");
		const form = container.querySelector("form");
		if (!form) throw new Error("Form missing");
		textarea.focus();
		expect(textarea.form).toBe(form);
		expect(form.querySelector('button[type="submit"]:disabled')).toBeNull();
		await act(async () => {
			textarea.dispatchEvent(
				new dom.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
			);
			textarea.dispatchEvent(
				new dom.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
			);
		});
		expect(submissions).toBe(0);
		await act(async () => {
			textarea.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		expect(submissions).toBe(1);
		await render(false, true);
		await act(async () => {
			textarea.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		});
		expect(submissions).toBe(1);
		await render(true);
		await act(async () => {
			container.querySelector("button")?.click();
		});
		expect(stops).toBe(1);
		expect(submissions).toBe(1);
		await act(async () => root.unmount());
		container.remove();
	});
});
describe("streaming response", () => {
	test("renders Markdown and unfinished formatting without executing HTML or fetching images", () => {
		const html = renderToStaticMarkup(
			<MessageResponse>{"**Project**\n\n- Garden\n- Demo\n\nunfinished **bold"}</MessageResponse>,
		);
		expect(html).toContain('data-streamdown="strong"');
		expect(html).toContain("<li");
		expect(html).not.toContain("unfinished **");
		const unsafe = renderToStaticMarkup(
			<MessageResponse>
				{"<script>alert(1)</script>\n\n![secret](https://example.com/tracker)\n\n[bad](javascript:alert(1))"}
			</MessageResponse>,
		);
		expect(unsafe).not.toContain("<script");
		expect(unsafe).not.toContain("<img");
		expect(unsafe).not.toContain('href="javascript:');
	});
});

describe("inline sources", () => {
	test("formats plain references and preserves fenced code examples", () => {
		expect(formatSourceReferences("[Source: artifact:imports/import:revision/Buse.md]")).toBe(
			"`artifact:imports/import:revision/Buse.md`",
		);
		const example = "```text\n[Source: `artifact:imports/Buse.md`]\n```";
		expect(formatSourceReferences(example)).toBe(example);
	});
	test("replaces artifact and memory citations with readable pills while preserving ordinary code", () => {
		const html = renderToStaticMarkup(
			<MessageResponse
				citations={[
					{ sourceRef: "artifact:imports/import:43d589e096e26c8d:d73b9d6f/Buse.md", excerpt: "Project evidence" },
					{ sourceRef: "memory:86ce866c-b26c-4488-8245-79bf87e0c416", excerpt: "Memory evidence" },
				]}
			>
				{
					"Buse works on projects. [Source: `artifact:imports/import:43d589e096e26c8d:d73b9d6f/Buse.md`] Also (`memory:86ce866c-b26c-4488-8245-79bf87e0c416`). Keep `foo()` as code."
				}
			</MessageResponse>,
		);
		expect(html).toContain("View source: Buse.md");
		expect(html).toContain("View source: Memory");
		expect(html).not.toContain("import:43d589e096e26c8d");
		expect(html).not.toContain("[Source:");
		expect(html).toContain("foo()");
	});
	test("wikilinks render only retrieved evidence, including spaces and transcripts", () => {
		const html = renderToStaticMarkup(
			<MessageResponse
				citations={[
					{ sourceRef: "artifact:imports/Person note.md", excerpt: "Retrieved source" },
					{ sourceRef: "transcript:session-123", excerpt: "Retrieved transcript" },
				]}
			>
				{
					"Supported. [[artifact:imports/Person note.md]] [[transcript:session-123]] Unverified: [[memory:invented]] Ordinary: [[Project]]"
				}
			</MessageResponse>,
		);
		expect(html).toContain("View source: Person note.md");
		expect(html).toContain("View source: Transcript");
		expect(html).not.toContain("View source: Memory");
		expect(html).toContain("memory:invented");
		expect(html).toContain("[[Project]]");
	});
});
