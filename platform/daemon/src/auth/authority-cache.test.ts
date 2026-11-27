import { describe, expect, test } from "bun:test";
import {
	acceptCredentialAuthority,
	cachedAuthorityQuery,
	withCredentialAuthority,
	withoutCredentialAuthority,
} from "./authority-cache";
import type { DbOwnerStatement } from "../db-owner-protocol";

const statement: DbOwnerStatement = { sql: "SELECT role FROM users WHERE id=?", params: ["fixture"], result: "get" };

describe("credential authority reads", () => {
	test("accepted reads are credential-bound and invalidated by an epoch or owner change", async () => {
		let version: string | null = "owner-one:1";
		let calls = 0;
		let role = "member";
		const read = (credential: string) =>
			withCredentialAuthority(credential, async () => {
				const value = await cachedAuthorityQuery(
					statement,
					() => version,
					async () => {
						calls++;
						return { role };
					},
				);
				acceptCredentialAuthority();
				return value;
			});
		expect(await read("first-credential")).toEqual({ role: "member" });
		expect(await read("first-credential")).toEqual({ role: "member" });
		expect(calls).toBe(1);
		await read("different-credential");
		expect(calls).toBe(2);
		role = "readonly";
		version = "owner-one:2";
		expect(await read("first-credential")).toEqual({ role: "readonly" });
		expect(calls).toBe(3);
		version = null;
		await read("first-credential");
		expect(calls).toBe(4);
		version = "owner-two:0";
		await read("first-credential");
		expect(calls).toBe(5);
	});

	test("unverified credentials and downstream work cannot populate authority cache", async () => {
		let calls = 0;
		const load = async () => {
			calls++;
			return { role: "member" };
		};
		for (let i = 0; i < 2; i++)
			await withCredentialAuthority("unverified-credential", () =>
				cachedAuthorityQuery(statement, () => "unverified:0", load),
			);
		expect(calls).toBe(2);
		await withCredentialAuthority("downstream-credential", async () => {
			await cachedAuthorityQuery(statement, () => "downstream:0", load);
			acceptCredentialAuthority();
			await withoutCredentialAuthority(() => cachedAuthorityQuery(statement, () => "downstream:0", load));
		});
		expect(calls).toBe(4);
	});

	test("cached values are detached and content reads are never cached", async () => {
		let calls = 0;
		const read = (query: DbOwnerStatement) =>
			withCredentialAuthority("detached-credential", async () => {
				const value = await cachedAuthorityQuery(
					query,
					() => "detached:0",
					async () => {
						calls++;
						return { role: "member" };
					},
				);
				acceptCredentialAuthority();
				return value;
			});
		const first = await read(statement);
		if (typeof first !== "object" || first === null) throw new Error("Missing result");
		Reflect.set(first, "role", "admin");
		expect(await read(statement)).toEqual({ role: "member" });
		expect(calls).toBe(1);
		const content: DbOwnerStatement = {
			sql: "SELECT content FROM memories WHERE id=?",
			params: ["fixture"],
			result: "get",
		};
		await read(content);
		await read(content);
		expect(calls).toBe(3);
	});
});
