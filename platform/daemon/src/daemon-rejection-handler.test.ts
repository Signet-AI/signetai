import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON_ENTRY = join(import.meta.dir, "daemon.ts");
const DB_OWNER_CLIENT = join(import.meta.dir, "db-owner-client.ts");

const AVAILABILITY_CODES = [
	"DB_OWNER_DEADLINE",
	"DB_OWNER_CANCELLED",
	"DB_OWNER_QUEUE_FULL",
	"DB_OWNER_WORK_BUDGET",
] as const;

const FATAL_DB_OWNER_CODES = [
	"DB_OWNER_DIED",
	"DB_OWNER_START_TIMEOUT",
	"DB_OWNER_START_TIMEOUT_INVALID",
	"DB_OWNER_JOB_FAILED",
	"DB_OWNER_WRITES_BLOCKED",
	"DB_OWNER_CLOSED",
] as const;

type Scenario =
	| { readonly kind: "code"; readonly code: string; readonly survive: boolean }
	| { readonly kind: "serialized"; readonly code: string | null }
	| { readonly kind: "plain"; readonly survive: false };

function scenarioLabel(scenario: Scenario): string {
	if (scenario.kind === "serialized") return `serialized (${scenario.code ?? "no code"})`;
	if (scenario.kind === "plain") return "plain Error";
	return scenario.code;
}

function scenarioErrorExpression(scenario: Scenario): string {
	if (scenario.kind === "serialized") {
		if (scenario.code === null) return 'new DbOwnerError("SERIALIZED_PROBE", "serialized")';
		return `new DbOwnerError(${JSON.stringify(scenario.code)}, "serialized")`;
	}
	if (scenario.kind === "plain") return 'new Error("plain probe")';
	return `new DbOwnerError(${JSON.stringify(scenario.code)}, "probe")`;
}

const serializedCases: readonly Scenario[] = [
	{ kind: "serialized", code: "SQLITE_CONSTRAINT" },
	{ kind: "serialized", code: null },
];

const scenarios: readonly Scenario[] = [
	...AVAILABILITY_CODES.map((code): Scenario => ({ kind: "code", code, survive: true })),
	...FATAL_DB_OWNER_CODES.map((code): Scenario => ({ kind: "code", code, survive: false })),
	...serializedCases,
	{ kind: "code", code: "DB_OWNER_UNKNOWN_PROBE", survive: false },
	{ kind: "plain", survive: false },
];

function runScenario(scenario: Scenario): { exitCode: number | null; lifecycleState: string | null } {
	const home = mkdtempSync(join(tmpdir(), "signet-rejection-probe-"));
	const scriptPath = join(home, "probe.ts");
	const raise = scenarioErrorExpression(scenario);
	const script = [
		`import ${JSON.stringify(DAEMON_ENTRY)};`,
		`import { DbOwnerError } from ${JSON.stringify(DB_OWNER_CLIENT)};`,
		`setTimeout(() => {`,
		`  Promise.reject(${raise});`,
		`}, 20);`,
		`setTimeout(() => process.exit(0), 1000);`,
	].join("\n");
	try {
		writeFileSync(scriptPath, script);
		const result = spawnSync(process.execPath, [scriptPath], {
			env: { ...process.env, SIGNET_PATH: home },
			encoding: "utf8",
			timeout: 20_000,
		});
		let lifecycleState: string | null = null;
		try {
			lifecycleState =
				(
					JSON.parse(readFileSync(join(home, ".daemon", "lifecycle.json"), "utf8")) as {
						state?: string;
					}
				).state ?? null;
		} catch {
			lifecycleState = null;
		}
		return { exitCode: result.status, lifecycleState };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("daemon unhandledRejection survivability by DB owner code", () => {
	test("exposes the availability allowlist as the DB owner contract", () => {
		const { DB_OWNER_SURVIVABLE_CODES } = require("./db-owner-client.ts") as {
			DB_OWNER_SURVIVABLE_CODES: ReadonlySet<string>;
		};
		expect([...DB_OWNER_SURVIVABLE_CODES].sort()).toEqual([...AVAILABILITY_CODES].sort());
	});

	for (const scenario of scenarios) {
		const expectedExit = scenario.kind === "code" && scenario.survive ? 0 : 1;
		test(`${scenarioLabel(scenario)} → ${
			scenario.kind === "code" && scenario.survive ? "survives" : "shuts down"
		}`, () => {
			const { exitCode } = runScenario(scenario);
			expect(exitCode).toBe(expectedExit);
		});
	}

	test("a survivable rejection leaves no error lifecycle record", () => {
		const { lifecycleState } = runScenario({ kind: "code", code: "DB_OWNER_DEADLINE", survive: true });
		expect(lifecycleState === null || lifecycleState === "running").toBe(true);
	});

	test("a fatal DB owner rejection records an error lifecycle", () => {
		const { lifecycleState } = runScenario({ kind: "code", code: "DB_OWNER_DIED", survive: false });
		expect(lifecycleState).toBe("error");
	});
});
