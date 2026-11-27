import { expect, test } from "bun:test";
import { instanceOrigin } from "./entry";

test("onboarding links accept only credential-free instance origins safe to copy into commands", () => {
	for (const input of ["https://memory.example", "http://127.0.0.1:3850", "http://[::1]:3850"])
		expect(instanceOrigin(input)).toBe(input);
	for (const input of [
		"javascript:alert(1)",
		"https://alice:password@memory.example",
		"https://memory.example/path",
		"https://memory.example/?token=secret",
		"https://memory.example/#token",
		"http://foo;whoami",
		"http://$(whoami)",
		"",
	])
		expect(instanceOrigin(input)).toBeNull();
});
