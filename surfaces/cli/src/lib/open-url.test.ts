import { describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
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

	it("prints the manual URL when a headless opener exits nonzero (#1477)", async () => {
		const lines: string[] = [];
		let waitOption: boolean | undefined;
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/headless", {
				open: async (_url, options) => {
					waitOption = options?.wait;
					const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(7), 25)"]);
					if (options?.wait !== true) {
						child.unref();
						return child;
					}

					await new Promise<void>((resolve, reject) => {
						child.once("error", reject);
						child.once("close", (code) => {
							if (code === 0) {
								resolve();
								return;
							}

							reject(new Error(`Headless opener exited with code ${code}`));
						});
					});
					return child;
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(waitOption).toBe(true);
		expect(lines.join("\n")).toContain("Paste this URL into your browser:");
		expect(lines.join("\n")).toContain("https://example.com/headless");
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
