import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Command } from "commander";
import type { DaemonFetchResult } from "../lib/daemon.js";
import { type DreamDeps, registerDreamCommands } from "./dream.js";

const previousLog = console.log;
const previousError = console.error;

afterEach(() => {
	console.log = previousLog;
	console.error = previousError;
});

function okResult<T>(data: T): DaemonFetchResult<T> {
	return { ok: true, data };
}

function httpError<T>(status: number, error?: string, body?: unknown): DaemonFetchResult<T> {
	return {
		ok: false,
		reason: "http",
		status,
		...(error ? { error } : {}),
		...(body === undefined ? {} : { body }),
	};
}
function mockFetch(
	impl: (path: string, options?: RequestInit & { timeout?: number }) => Promise<DaemonFetchResult<unknown>>,
): DreamDeps["fetchDaemonResult"] {
	return (async (path: string, options?: RequestInit & { timeout?: number }) =>
		impl(path, options)) as DreamDeps["fetchDaemonResult"];
}

function makeDeps(): DreamDeps {
	return {
		fetchFromDaemon: async () => null,
		fetchDaemonResult: async () => ({ ok: false, reason: "offline" }),
	};
}

function captureOutput(): { lines: string[]; errorLines: string[]; restore: () => void } {
	const lines: string[] = [];
	const errorLines: string[] = [];
	console.log = (...args: unknown[]) => {
		lines.push(args.join(" "));
	};
	console.error = (...args: unknown[]) => {
		errorLines.push(args.join(" "));
	};
	return {
		lines,
		errorLines,
		restore: () => {
			console.log = previousLog;
			console.error = previousError;
		},
	};
}

interface StatusPayload {
	worker: { running: boolean; active: boolean };
	state: {
		consecutiveFailures: number;
		lastPassAt: string | null;
		evidenceCursor: null;
		lastPassId: string | null;
		lastPassMode: string | null;
	};
	episodicTokensPending: number | null;
	config: { tokenThreshold: number; backfillOnFirstRun: boolean };
	passes: Array<{
		id: string;
		mode: string;
		status: string;
		startedAt: string;
		completedAt: string | null;
		tokensConsumed: number | null;
		mutationsApplied: number | null;
		mutationsSkipped: number | null;
		mutationsFailed: number | null;
		summary: string | null;
		error: string | null;
	}>;
}

function makeStatus(passes: Array<{ id: string; status: string; error?: string | null }>): StatusPayload {
	return {
		worker: { running: true, active: false },
		state: {
			consecutiveFailures: 0,
			lastPassAt: null,
			evidenceCursor: null,
			lastPassId: null,
			lastPassMode: null,
		},
		episodicTokensPending: 0,
		config: { tokenThreshold: 10_000, backfillOnFirstRun: false },
		passes: passes.map((pass) => ({
			id: pass.id,
			mode: "incremental",
			status: pass.status,
			startedAt: "2026-08-05T00:00:00.000Z",
			completedAt: pass.status === "running" ? null : "2026-08-05T00:01:00.000Z",
			tokensConsumed: null,
			mutationsApplied: pass.status === "completed" ? 3 : null,
			mutationsSkipped: null,
			mutationsFailed: null,
			summary: null,
			error: pass.error ?? null,
		})),
	};
}

describe("Dreaming capability CLI binding", () => {
	it("discovers the daemon-owned registry without a local capability list", async () => {
		const calls: string[] = [];
		const fetchFromDaemon: DreamDeps["fetchFromDaemon"] = (async (path: string) => {
			calls.push(path);
			return { items: [{ id: "search_entities", description: "Search entities" }] };
		}) as DreamDeps["fetchFromDaemon"];
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchFromDaemon });
		const capture = captureOutput();
		try {
			await program.parseAsync(["node", "test", "dream", "capabilities"]);
		} finally {
			capture.restore();
		}
		expect(calls).toEqual(["/api/dream/tools"]);
	});

	it("routes any registered capability through the daemon capability endpoint with an explicit agent scope", async () => {
		const calls: Array<{ path: string; options?: RequestInit }> = [];
		const fetchDaemonResult = mockFetch(async (path: string, options) => {
			calls.push({ path, options });
			return okResult({ ok: true, tool: "search_entities", items: [] });
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		try {
			await program.parseAsync([
				"node",
				"test",
				"dream",
				"tool",
				"search_entities",
				"--agent",
				"agent-a",
				"--pass-id",
				"pass-a",
				"--input",
				'{"query":"Atlas"}',
			]);
		} finally {
			capture.restore();
		}
		expect(calls).toEqual([
			{
				path: "/api/dream/tools/search_entities",
				options: expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ input: { query: "Atlas" }, agentId: "agent-a", passId: "pass-a" }),
				}),
			},
		]);
	});

	it("surfaces the daemon's error body when a capability call fails", async () => {
		const fetchDaemonResult = mockFetch(async () => httpError(400, "evidence must include an exact quote"));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(
				program.parseAsync(["node", "test", "dream", "tool", "runbook_write", "--input", "{}"]),
			).rejects.toThrow("EXIT_1");
			expect(capture.errorLines.join("\n")).toContain("evidence must include an exact quote");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("prints the structured suffix-only retry boundary for a retryable capability failure", async () => {
		const fetchDaemonResult = mockFetch(async () =>
			httpError(503, "injected writer rejection", {
				tool: "apply_ontology_ops",
				ok: false,
				retryable: true,
				retryFrom: 20,
				items: Array.from({ length: 20 }, (_, index) => ({ index, ok: true })),
			}),
		);
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(
				program.parseAsync(["node", "test", "dream", "tool", "apply_ontology_ops", "--input", "{}"]),
			).rejects.toThrow("EXIT_1");
			const output = capture.errorLines.join("\n");
			expect(output).toContain("operations.slice(20)");
			expect(output).toContain('"retryFrom": 20');
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});
});

describe("dream status failure labeling", () => {
	it("labels an unmeasured episodic backlog instead of printing null", async () => {
		const fetchDaemonResult = mockFetch(async () => okResult({ ...makeStatus([]), episodicTokensPending: null }));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		try {
			await program.parseAsync(["node", "test", "dream", "status"]);
			const output = capture.lines.join("\n");
			expect(output).toContain("unmeasured / 10000 episodic tokens");
			expect(output).not.toContain("null / 10000");
		} finally {
			capture.restore();
		}
	});

	it("names an unresponsive daemon instead of asking whether it is running", async () => {
		const fetchDaemonResult = mockFetch(async () => ({ ok: false, reason: "timeout" }));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "status"])).rejects.toThrow("EXIT_1");
			const output = capture.errorLines.join("\n");
			expect(output).toContain("not responding");
			expect(output).toContain("event loop");
			expect(output).not.toContain("is the daemon running?");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("keeps the stopped-daemon wording when the probe is refused (offline)", async () => {
		const fetchDaemonResult = mockFetch(async () => ({ ok: false, reason: "offline" }));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "status"])).rejects.toThrow("EXIT_1");
			expect(capture.errorLines.join("\n")).toContain("is the daemon running?");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});
});

describe("dream trigger pass diagnostics", () => {
	it("surfaces the daemon's error when the trigger itself is rejected", async () => {
		const fetchDaemonResult = mockFetch(async (path: string) => {
			return path === "/api/dream/trigger"
				? httpError(500, "No routing policy is configured.")
				: { ok: false, reason: "offline" };
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "trigger"])).rejects.toThrow("EXIT_1");
			expect(capture.errorLines.join("\n")).toContain("No routing policy is configured.");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("surfaces the pass's terminal error instead of hiding it", async () => {
		const fetchDaemonResult = mockFetch(async (path: string) => {
			if (path === "/api/dream/trigger") {
				return okResult({ accepted: true, passId: "pass-1", status: "running", mode: "incremental" });
			}
			return okResult(makeStatus([{ id: "pass-1", status: "failed", error: "No routing policy is configured." }]));
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "trigger"])).rejects.toThrow("EXIT_1");
			expect(capture.errorLines.join("\n")).toContain("No routing policy is configured.");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("does not claim completion while a pass is still running", async () => {
		const fetchDaemonResult = mockFetch(async (path: string) => {
			if (path === "/api/dream/trigger") {
				return okResult({ accepted: true, passId: "pass-1", status: "running", mode: "incremental" });
			}
			return okResult(makeStatus([{ id: "pass-1", status: "running" }]));
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), pollIntervalMs: 1, minWaitMs: 1, fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await program.parseAsync(["node", "test", "dream", "trigger", "--wait-secs", "1"]);
			const output = capture.lines.join("\n");
			expect(output).toContain("still running");
			expect(output).not.toContain("complete");
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("names an unresponsive daemon when status polls time out during a pass", async () => {
		const fetchDaemonResult = mockFetch(async (path: string) => {
			if (path === "/api/dream/trigger") {
				return okResult({ accepted: true, passId: "pass-1", status: "running", mode: "incremental" });
			}
			return { ok: false, reason: "timeout" };
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await program.parseAsync(["node", "test", "dream", "trigger"]);
			const output = capture.lines.join("\n");
			expect(output).toContain("not responding");
			expect(output).toContain("event loop");
			expect(output).not.toContain("Could not retrieve pass result");
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});
});

describe("dream attach selection", () => {
	it("reports an active-pass lookup timeout without claiming daemon outage", async () => {
		const calls: string[] = [];
		const fetchDaemonResult = mockFetch(async (path: string) => {
			calls.push(path);
			return { ok: false, reason: "timeout" };
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			const output = capture.errorLines.join("\n");
			expect(calls).toEqual(["/api/dream/passes/active"]);
			expect(output).toContain("Dreaming pass lookup timed out");
			expect(output).toContain("/api/dream/passes/active");
			expect(output).toContain("--pass-id <id>");
			expect(output).toContain("Retry once");
			expect(output).toContain("signet dream status");
			expect(output).not.toContain("event loop may be blocked");
			expect(output).not.toContain("is the daemon running?");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("identifies an unreachable daemon during active-pass lookup", async () => {
		const fetchDaemonResult = mockFetch(async () => ({ ok: false, reason: "offline" }));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			expect(capture.errorLines.join("\n")).toContain("Could not reach the Signet daemon");
			expect(capture.errorLines.join("\n")).not.toContain("lookup timed out");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("preserves the daemon HTTP status and error for active-pass lookup failures", async () => {
		const fetchDaemonResult = mockFetch(async () => httpError(503, "owner request timed out"));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			const output = capture.errorLines.join("\n");
			expect(output).toContain("HTTP 503");
			expect(output).toContain("owner request timed out");
			expect(output).not.toContain("is the daemon running?");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("does not label an invalid daemon response as offline", async () => {
		const fetchDaemonResult = mockFetch(async () => ({ ok: false, reason: "invalid-json", status: 200 }));
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			const output = capture.errorLines.join("\n");
			expect(output).toContain("returned invalid JSON (HTTP 200)");
			expect(output).not.toContain("Could not reach the Signet daemon");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("uses a pass returned after a delay instead of reporting a lookup timeout", async () => {
		const calls: string[] = [];
		const fetchDaemonResult = mockFetch(async (path: string) => {
			calls.push(path);
			await new Promise((resolve) => setTimeout(resolve, 10));
			return okResult({
				agentId: "agent-a",
				items: [{ id: "pass-late", mode: "incremental", status: "running", startedAt: "2026-08-05T00:00:00.000Z" }],
			});
		});
		const program = new Command();
		registerDreamCommands(program, {
			...makeDeps(),
			fetchDaemonResult,
			fetchDaemonStream: async () => ({ ok: true, response: new Response("") }),
		});
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			expect(calls).toEqual(["/api/dream/passes/active"]);
			const output = capture.errorLines.join("\n");
			expect(output).toContain("requires an interactive terminal");
			expect(output).not.toContain("lookup timed out");
			expect(output).not.toContain("No Dreaming pass is currently active");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("bypasses active-pass discovery when a pass ID is provided", async () => {
		const calls: string[] = [];
		const fetchDaemonResult = mockFetch(async (path: string) => {
			calls.push(path);
			return { ok: false, reason: "timeout" };
		});
		const program = new Command();
		registerDreamCommands(program, {
			...makeDeps(),
			fetchDaemonResult,
			fetchDaemonStream: async () => ({ ok: true, response: new Response("") }),
		});
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(
				program.parseAsync(["node", "test", "dream", "attach", "--pass-id", "pass-explicit"]),
			).rejects.toThrow("EXIT_1");
			expect(calls).toEqual([]);
			expect(capture.errorLines.join("\n")).toContain("requires an interactive terminal");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("refuses to open an empty view when no pass is active", async () => {
		const calls: string[] = [];
		const fetchDaemonResult = mockFetch(async (path: string) => {
			calls.push(path);
			return okResult({ agentId: "default", items: [] });
		});
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			expect(calls).toEqual(["/api/dream/passes/active"]);
			const output = capture.errorLines.join("\n");
			expect(output).toContain("No Dreaming pass is currently active.");
			expect(output).toContain("signet dream status");
			expect(output).not.toContain("lookup timed out");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});

	it("requires explicit selection when multiple passes are active", async () => {
		const fetchDaemonResult = mockFetch(async () =>
			okResult({
				agentId: "default",
				items: [
					{ id: "pass-a", mode: "incremental", status: "running", startedAt: "2026-08-05T00:00:00.000Z" },
					{ id: "pass-b", mode: "compact", status: "running", startedAt: "2026-08-05T00:01:00.000Z" },
				],
			}),
		);
		const program = new Command();
		registerDreamCommands(program, { ...makeDeps(), fetchDaemonResult });
		const capture = captureOutput();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("EXIT_1");
		});
		try {
			await expect(program.parseAsync(["node", "test", "dream", "attach"])).rejects.toThrow("EXIT_1");
			const output = capture.errorLines.join("\n");
			expect(output).toContain("--pass-id");
			expect(output).toContain("pass-a");
			expect(output).toContain("pass-b");
		} finally {
			exitSpy.mockRestore();
			capture.restore();
		}
	});
});
