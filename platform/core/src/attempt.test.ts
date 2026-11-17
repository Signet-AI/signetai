import { expect, test } from "bun:test";
import { attempt, attemptAsync } from "./attempt";

test("attempt preserves values and maps expected misses to undefined", () => {
	const value = { found: true };
	expect(attempt(() => value)).toBe(value);
	expect(
		attempt(() => {
			throw new Error("missing");
		}),
	).toBeUndefined();
});

test("attemptAsync awaits values and catches throws and rejections", async () => {
	const value = { found: true };
	expect(await attemptAsync(async () => value)).toBe(value);
	expect(
		await attemptAsync(() => {
			throw new Error("missing");
		}),
	).toBeUndefined();
	expect(await attemptAsync(() => Promise.reject(new Error("missing")))).toBeUndefined();
});
