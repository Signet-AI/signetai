import { expect, test } from "bun:test";
import { hashPassword, verifyPasswordHash } from "./password";

test("R9 new password hashes use 600000 iterations and stored older counts still verify", () => {
	const hash = hashPassword("fixture password");
	expect(hash.split("$")[1]).toBe("600000");
	expect(verifyPasswordHash("fixture password", hash)).toBe(true);
	expect(verifyPasswordHash("fixture password", hashPassword("fixture password", 10000))).toBe(true);
});
