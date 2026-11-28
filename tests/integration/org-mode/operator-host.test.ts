import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { Fixture, device } from "./fixture";
import { record, request, success, text, until } from "./http";
import effects from "../../../platform/daemon/src/route-effects.json";

test("organization admin sessions cannot execute host commands or inspect execution jobs", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon);
		const admin = await device(daemon, fixture.admin, "host-denied");
		success(
			await request(daemon.origin, "/api/secrets/OPX_TEST", admin.credential, "POST", { value: "v" }),
			"create exec fixture secret",
		);
		for (const [method, path] of [
			["POST", "/api/secrets/exec"],
			["GET", "/api/secrets/exec/missing"],
			["POST", "/api/secrets/OPX_TEST/exec"],
		] as const) {
			const result = await request(
				daemon.origin,
				path,
				admin.credential,
				method,
				method === "POST"
					? {
							command: `cp ${daemon.workspace}/data/signet.db ${daemon.root}/pwned-marker`,
							secrets: { OPX: "OPX_TEST" },
						}
					: undefined,
			);
			expect({ path, status: result.status }).toEqual({ path, status: 403 });
		}
		for (const routes of Object.values(effects)) {
			for (const [route, effect] of Object.entries(routes)) {
				if (effect !== "host") continue;
				const [method, pattern] = route.split(" ");
				if (!method || !pattern) throw new Error("Invalid effect declaration");
				for (const action of /\$\{action\}/.test(pattern)
					? ["connect", "disconnect", "repair", "reinitialize"]
					: ["probe"]) {
					const path = pattern.replace(/\$\{[^}]+\}/g, action).replace(/:[^/]+/g, "probe");
					const result = await request(
						daemon.origin,
						path,
						admin.credential,
						method,
						method === "GET" ? undefined : {},
					);
					expect({ route, path, status: result.status }).toEqual({ route, path, status: 403 });
				}
			}
		}
		const form = new FormData();
		form.append("paths", `${daemon.home}/arbitrary.txt`);
		const filesystem = await fetch(`${daemon.origin}/api/sources/import`, {
			method: "POST",
			headers: { authorization: `Bearer ${admin.credential.bearer}` },
			body: form,
		});
		expect(filesystem.status).toBe(403);
		for (const name of ["signet_code_status", "code_status", "signet_code_clear", "code_clear"]) {
			const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } };
			for (const payload of [call, [call]]) {
				const response = await fetch(`${daemon.origin}/mcp`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${admin.credential.bearer}`,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
					},
					body: JSON.stringify(payload),
				});
				expect({ name, status: response.status }).toEqual({ name, status: 403 });
			}
		}
		expect(await Bun.file(join(daemon.root, "pwned-marker")).exists()).toBe(false);
		await daemon.stop();
		const configPath = join(daemon.workspace, "agent.yaml");
		await writeFile(configPath, (await readFile(configPath, "utf8")).replace("mode: team", "mode: local"));
		await daemon.start();
		const marker = join(daemon.root, "local-marker");
		const job = success(
			await request(daemon.origin, "/api/secrets/exec", {}, "POST", {
				command: `touch ${marker}`,
				secrets: { OPX: "OPX_TEST" },
			}),
			"local execution still accepted",
		);
		await until(async () => {
			const state = success(
				await request(daemon.origin, `/api/secrets/exec/${text(job.id)}`),
				"local execution status",
			);
			if (state.status !== "completed") return false;
			expect(record(state.result).code).toBe(0);
			return true;
		}, "local host command completion");
		expect(await Bun.file(marker).exists()).toBe(true);
	} finally {
		await daemon.dispose();
	}
}, 60_000);
