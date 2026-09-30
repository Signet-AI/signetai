import { describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import {
	buildDesktopDeepLinkInvocation,
	buildWindowsOpenInvocation,
	openDashboardWithDesktopFallback,
	openUrlWithFallback,
} from "./open-url.js";

describe("openUrlWithFallback", () => {
	it("passes Windows browser URLs as data to a static PowerShell command", () => {
		const url = 'https://example.com/search?q=one&next=`"quoted"';
		const invocation = buildWindowsOpenInvocation(url);
		const command = invocation.args.at(-1);

		expect(command).toBe("$ErrorActionPreference = 'Stop'; $url = $env:SIGNET_OPEN_URL; Start-Process -FilePath $url;");
		expect(command).not.toContain(url);
		expect(invocation.options.env.SIGNET_OPEN_URL).toBe(url);
		expect(invocation.options.stdio).toBe("ignore");
		expect(invocation.options).not.toHaveProperty("detached");
	});

	it("builds native launches for the packaged desktop app on each platform", () => {
		expect(buildDesktopDeepLinkInvocation("setup", "win32")).toMatchObject({
			command: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", expect.any(String)],
			options: { stdio: "ignore", env: { SIGNET_OPEN_URL: "signet://setup" } },
		});
		expect(buildDesktopDeepLinkInvocation("setup", "darwin")).toEqual({
			command: "open",
			args: ["-b", "ai.signet.app", "signet://setup"],
			options: { stdio: "ignore" },
		});
		expect(buildDesktopDeepLinkInvocation("setup", "linux")).toEqual({
			command: "gio",
			args: ["launch", "signet.desktop", "signet://setup"],
			options: { stdio: "ignore" },
		});
		expect(buildDesktopDeepLinkInvocation("setup", "freebsd")).toBeNull();
	});

	it("prints a usable manual URL when opening the browser fails (#1477)", async () => {
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/oauth", {
				platform: "linux",
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

	it("keeps a still-running opener alive after the launch grace period", async () => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"]);
		const lines: string[] = [];
		let waitOption: boolean | undefined;
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/stuck", {
				platform: "linux",
				open: async (_url, options) => {
					waitOption = options?.wait;
					return child;
				},
				timeoutMs: 10,
			});

			expect(waitOption).toBe(false);
			expect(child.killed).toBe(false);
			expect(lines).toEqual([]);
		} finally {
			log.mockRestore();
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	});

	it("prints the manual URL when a headless opener exits nonzero (#1477)", async () => {
		const lines: string[] = [];
		let waitOption: boolean | undefined;
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/headless", {
				platform: "linux",
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

		expect(waitOption).toBe(false);
		expect(lines.join("\n")).toContain("Paste this URL into your browser:");
		expect(lines.join("\n")).toContain("https://example.com/headless");
	});

	it("opens the browser on macOS when an Aqua session is available", async () => {
		const opened: string[] = [];
		const lines: string[] = [];
		let waitOption: boolean | undefined;
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openUrlWithFallback("https://example.com/macos", {
				platform: "darwin",
				hasGuiSession: async () => true,
				open: async (url, options) => {
					opened.push(url);
					waitOption = options?.wait;
					return undefined;
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(opened).toEqual(["https://example.com/macos"]);
		expect(waitOption).toBe(false);
		expect(lines).toEqual([]);
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
					return undefined;
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
				platform: "linux",
				open: async (url) => {
					opened.push(url);
					return undefined;
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(opened).toEqual(["https://example.com/dashboard"]);
		expect(lines).toEqual([]);
	});

	it("opens setup in the desktop app before using the browser URL", async () => {
		const opened: string[] = [];
		await openDashboardWithDesktopFallback("http://127.0.0.1:3850/#setup", "setup", {
			platform: "linux",
			open: async (url) => {
				opened.push(url);
				return undefined;
			},
		});

		expect(opened).toEqual(["signet://setup"]);
	});

	for (const platform of ["darwin", "linux", "win32"] as const) {
		it(`uses the same setup deep link on ${platform}`, async () => {
			const opened: string[] = [];
			await openDashboardWithDesktopFallback("http://127.0.0.1:3850/#setup", "setup", {
				platform,
				hasGuiSession: async () => true,
				hasWindowsProtocolHandler: async () => true,
				open: async (url) => {
					opened.push(url);
					return undefined;
				},
			});

			expect(opened).toEqual(["signet://setup"]);
		});
	}

	it("falls back to the local browser dashboard when no desktop handler is available", async () => {
		const opened: string[] = [];
		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			await openDashboardWithDesktopFallback("http://127.0.0.1:3850/#setup", "setup", {
				platform: "linux",
				open: async (url) => {
					opened.push(url);
					if (url === "signet://setup") throw new Error("Signet desktop handler is unavailable");
					return undefined;
				},
			});
		} finally {
			log.mockRestore();
		}

		expect(opened).toEqual(["signet://setup", "http://127.0.0.1:3850/#setup"]);
		expect(lines).toEqual([]);
	});

	it("does not invoke an unregistered Windows protocol and falls back to the browser", async () => {
		const opened: string[] = [];
		await openDashboardWithDesktopFallback("http://127.0.0.1:3850/#setup", "setup", {
			platform: "win32",
			hasWindowsProtocolHandler: async () => false,
			open: async (url) => {
				opened.push(url);
				return undefined;
			},
		});

		expect(opened).toEqual(["http://127.0.0.1:3850/#setup"]);
	});
});
