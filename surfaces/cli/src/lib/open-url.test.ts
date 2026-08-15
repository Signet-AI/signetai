import { describe, expect, it, spyOn } from "bun:test";
import { openUrlWithFallback } from "./open-url.js";

describe("openUrlWithFallback", () => {
	it("prints a usable manual URL when opening the browser fails (#1477)", async () => {
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/oauth", {
				open: async () => {
					throw new Error("browser unavailable");
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(lines.join("\n")).toContain("Paste this URL into your browser:");
		expect(lines.join("\n")).toContain("https://example.com/oauth");
	});

	it("falls back after a stuck browser opener instead of hanging", async () => {
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/stuck", {
				open: () => new Promise<unknown>(() => {}),
				timeoutMs: 10,
			});
		} finally {
			log.mockRestore();
		}

		expect(lines.join("\n")).toContain("https://example.com/stuck");
	});

	it("prints the manual URL without invoking open when macOS has no Aqua session", async () => {
		let openCalls = 0;
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("http://127.0.0.1:3850", {
				platform: "darwin",
				hasGuiSession: async () => false,
				open: async () => {
					openCalls += 1;
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(openCalls).toBe(0);
		expect(lines.join("\n")).toContain("Paste this URL into your browser:");
		expect(lines.join("\n")).toContain("http://127.0.0.1:3850");
	});

	it("keeps the successful browser-open path unchanged", async () => {
		const opened: string[] = [];
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/dashboard", {
				open: async (url) => {
					opened.push(url);
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(opened).toEqual(["https://example.com/dashboard"]);
		expect(lines).toEqual([]);
	});
});
