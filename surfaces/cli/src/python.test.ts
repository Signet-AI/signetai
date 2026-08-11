import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import EventEmitter from "node:events";
import { installPyenv } from "./python.js";

afterEach(() => {
	mock.restore();
});

describe("installPyenv", () => {
	test("uses bash to execute the pyenv installer pipeline (regression for #1480)", async () => {
		const childProcess = await import("node:child_process");
		const child = new EventEmitter() as unknown as ChildProcess;
		Object.assign(child, {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		const spawnSpy = spyOn(childProcess, "spawn").mockReturnValue(child);

		const installation = installPyenv();
		setTimeout(() => child.emit("close", 0), 0);

		expect(await installation).toEqual({ success: true });
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(spawnSpy.mock.calls[0]?.[0]).toBe("bash");
		expect(spawnSpy.mock.calls[0]?.[1]).toEqual(["-c", "curl https://pyenv.run | bash"]);
	});
});
