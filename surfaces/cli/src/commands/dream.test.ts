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

function httpError<T>(status: number, error?: string): DaemonFetchResult<T> {
	return error ? { ok: false, reason: "http", status, error } : { ok: false, reason: "http", status };
}

/**
 * The deps signature is generic over the response payload; TypeScript cannot
 * infer those type parameters from return position, so concrete mocks are
 * widened once here instead of at every call site.
 */
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
	episodicTokensPending: number;
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
});

describe("dream status failure labeling", () => {
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
