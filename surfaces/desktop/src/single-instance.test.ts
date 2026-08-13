import { describe, expect, test } from "bun:test";
import { installSingleInstanceLock, type SingleInstanceHost } from "./single-instance";

function makeHost(
	locked: boolean,
): SingleInstanceHost & { readonly quitCalls: number; readonly listeners: (() => void)[] } {
	let quitCalls = 0;
	const listeners: (() => void)[] = [];
	return {
		requestSingleInstanceLock: () => locked,
		quit: () => {
			quitCalls += 1;
		},
		onSecondInstance: (listener) => {
			listeners.push(listener);
		},
		get quitCalls() {
			return quitCalls;
		},
		listeners,
	};
}

describe("desktop single-instance lock", () => {
	test("lets the primary launch handle a second-instance focus event", () => {
		const host = makeHost(true);
		let focusCalls = 0;

		expect(
			installSingleInstanceLock(host, () => {
				focusCalls += 1;
			}),
		).toBe(true);
		expect(host.quitCalls).toBe(0);
		expect(host.listeners).toHaveLength(1);

		host.listeners[0]?.();
		expect(focusCalls).toBe(1);
	});

	test("quits a second launch before it can attempt another daemon spawn", () => {
		const host = makeHost(false);
		let focusCalls = 0;

		expect(
			installSingleInstanceLock(host, () => {
				focusCalls += 1;
			}),
		).toBe(false);
		expect(host.quitCalls).toBe(1);
		expect(host.listeners).toHaveLength(0);
		expect(focusCalls).toBe(0);
	});
});
