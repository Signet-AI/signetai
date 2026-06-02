import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as dbAccessor from "./db-accessor";

type EventRow = {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly epoch: number;
	readonly itemKind: string;
	readonly itemId: string;
	readonly surface: string;
	readonly mode: string;
	readonly score: number | null;
	readonly source: string | null;
};

type EpochRow = {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly epoch: number;
	readonly reason: string;
	readonly sourceRef: string | null;
};

const events = new Map<string, EventRow>();
const epochs = new Map<string, EpochRow>();
let changes = 0;

function eventKey(sessionKey: string, agentId: string, epoch: number, itemKind: string, itemId: string): string {
	return [sessionKey, agentId, epoch, itemKind, itemId].join("\0");
}

function epochKey(sessionKey: string, agentId: string, epoch: number): string {
	return [sessionKey, agentId, epoch].join("\0");
}

function currentEpoch(sessionKey: string, agentId: string): number {
	let max = 0;
	for (const row of epochs.values()) {
		if (row.sessionKey === sessionKey && row.agentId === agentId) {
			max = Math.max(max, row.epoch);
		}
	}
	return max;
}

const fakeDb = {
	prepare(sql: string) {
		return {
			get(...args: unknown[]) {
				if (sql.includes("sqlite_master")) return { count: 2 };
				if (sql.includes("SELECT MAX(context_epoch)")) {
					return { epoch: currentEpoch(String(args[0]), String(args[1])) };
				}
				if (sql.includes("SELECT changes()")) return { count: changes };
				throw new Error(`Unexpected get SQL: ${sql}`);
			},
			all(...args: unknown[]) {
				if (!sql.includes("FROM session_recall_events")) {
					throw new Error(`Unexpected all SQL: ${sql}`);
				}
				const sessionKey = String(args[0]);
				const agentId = String(args[1]);
				const epoch = Number(args[2]);
				const wanted = new Set<string>();
				for (let i = 3; i < args.length; i += 2) {
					wanted.add(`${String(args[i])}\0${String(args[i + 1])}`);
				}
				return [...events.values()]
					.filter(
						(row) =>
							row.sessionKey === sessionKey &&
							row.agentId === agentId &&
							row.epoch === epoch &&
							wanted.has(`${row.itemKind}\0${row.itemId}`),
					)
					.map((row) => ({ item_kind: row.itemKind, item_id: row.itemId }));
			},
			run(...args: unknown[]) {
				changes = 0;
				if (sql.includes("INSERT OR IGNORE INTO session_recall_events")) {
					const row: EventRow = {
						sessionKey: String(args[0]),
						agentId: String(args[1]),
						epoch: Number(args[2]),
						itemKind: String(args[3]),
						itemId: String(args[4]),
						surface: String(args[5]),
						mode: String(args[6]),
						score: typeof args[7] === "number" ? args[7] : null,
						source: typeof args[8] === "string" ? args[8] : null,
					};
					const key = eventKey(row.sessionKey, row.agentId, row.epoch, row.itemKind, row.itemId);
					if (!events.has(key)) {
						events.set(key, row);
						changes = 1;
					}
					return;
				}
				if (sql.includes("INSERT OR IGNORE INTO session_context_epochs")) {
					const row: EpochRow = {
						sessionKey: String(args[0]),
						agentId: String(args[1]),
						epoch: Number(args[2]),
						reason: String(args[3]),
						sourceRef: typeof args[4] === "string" ? args[4] : null,
					};
					const key = epochKey(row.sessionKey, row.agentId, row.epoch);
					if (!epochs.has(key)) {
						epochs.set(key, row);
						changes = 1;
					}
					return;
				}
				throw new Error(`Unexpected run SQL: ${sql}`);
			},
		};
	},
};

const getDbAccessorSpy = spyOn(dbAccessor, "getDbAccessor").mockImplementation(
	() =>
		({
			withWriteTx: <T>(fn: (db: typeof fakeDb) => T): T => fn(fakeDb),
		}) as ReturnType<typeof dbAccessor.getDbAccessor>,
);

const { advanceRecallContextEpoch, applyRecallDedupe, claimRecallItems } = await import("./session-recall-dedupe");

afterAll(() => {
	getDbAccessorSpy.mockRestore();
});

beforeEach(() => {
	events.clear();
	epochs.clear();
	changes = 0;
});

describe("session recall dedupe", () => {
	it("suppresses repeated rows within one session agent epoch", () => {
		const first = claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});
		expect(first.items.map((item) => item.id)).toEqual(["mem-1"]);
		expect(first.meta.contextEpoch).toBe(0);

		const second = claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [
				{ id: "mem-1", score: 0.9, source: "hybrid" },
				{ id: "mem-2", score: 0.8, source: "hybrid" },
			],
		});
		expect(second.items.map((item) => item.id)).toEqual(["mem-2"]);
		expect(second.meta.suppressed).toBe(1);
	});

	it("marks already recalled rows when includeRecalled is true", () => {
		claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});

		const result = applyRecallDedupe({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			claim: true,
			includeRecalled: true,
			items: [
				{ id: "mem-1", score: 0.9, source: "hybrid" },
				{ id: "mem-2", score: 0.8, source: "hybrid" },
			],
			markRepeated: (item) => ({ ...item, already_recalled: true }),
		});

		expect(result.items).toEqual([
			{ id: "mem-1", score: 0.9, source: "hybrid", already_recalled: true },
			{ id: "mem-2", score: 0.8, source: "hybrid" },
		]);
		expect(result.meta.repeatedReturned).toBe(1);
	});

	it("advances compaction epochs and isolates agents", () => {
		claimRecallItems({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});

		expect(
			claimRecallItems({
				sessionKey: "sess-1",
				agentId: "agent-b",
				surface: "test",
				mode: "direct",
				items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
			}).items,
		).toHaveLength(1);

		const epoch = advanceRecallContextEpoch({
			sessionKey: "sess-1",
			agentId: "agent-a",
			reason: "compaction-complete",
			sourceRef: "summary-1",
		});
		expect(epoch).toEqual({ advanced: true, contextEpoch: 1 });
		expect(
			claimRecallItems({
				sessionKey: "sess-1",
				agentId: "agent-a",
				surface: "test",
				mode: "direct",
				items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
			}).items,
		).toHaveLength(1);
	});

	it("leaves sessionless recall unchanged", () => {
		const first = claimRecallItems({
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});
		const second = claimRecallItems({
			surface: "test",
			mode: "direct",
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});

		expect(first.meta.enabled).toBe(false);
		expect(second.items.map((item) => item.id)).toEqual(["mem-1"]);
	});

	it("can filter already recalled rows without claiming unreturned candidates", () => {
		const result = applyRecallDedupe({
			sessionKey: "sess-1",
			agentId: "agent-a",
			surface: "test",
			mode: "automatic",
			claim: false,
			items: [{ id: "mem-1", score: 0.9, source: "hybrid" }],
		});
		expect(result.items).toHaveLength(1);
		expect(events.size).toBe(0);
	});
});
