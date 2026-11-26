import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { inspectConnectorFiles } from "../lib/connector-doctor";
import { Command } from "commander";
import { registerConnectorCommands } from "./connector.js";

for (const relativePath of [".claude.json", ".claude/hooks/x.sh"]) {
	test(`doctor finds credentials in ${relativePath}`, async () => {
		const home = homedir();
		expect(home).not.toBe("/home/nicholai");
		const previousHome = process.env.HOME;
		const previousLog = console.log;
		const lines: string[] = [];
		const secret = `sig_sk_${crypto.randomUUID()}`;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [] }) });
		const keyring = {
			get: async () => ({ state: "unsupported" as const }),
			set: async () => ({ state: "unsupported" as const }),
		};
		try {
			process.env.HOME = home;
			console.log = (...values: unknown[]) => {
				lines.push(values.map(String).join(" "));
			};
			await mkdir(join(home, ".claude/hooks"), { recursive: true });
			await writeFile(
				join(home, relativePath),
				JSON.stringify({ mcpServers: { signet: { env: { SIGNET_API_KEY: secret } } } }),
			);
			const program = new Command();
			registerConnectorCommands(program, { agentsDir: home, env: { HOME: home }, keyring, flagUrl: server.url.origin });
			await program.parseAsync(["connector", "doctor", "--json"], { from: "user" });
			expect(lines.join("\n")).toContain(join(home, relativePath));
			expect(lines.join("\n")).not.toContain(secret);
			expect(process.exitCode).toBe(1);
		} finally {
			server.stop(true);
			console.log = previousLog;
			process.exitCode = 0;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(join(home, relativePath), { force: true });
		}
	});
}

test.each(["sig_sk_", "legacy-"])(
	"connector doctor identifies %s credentials without returning their values",
	async (prefix) => {
		const home = await mkdtemp(join(tmpdir(), "doctor-"));
		const key = `${prefix}${crypto.randomUUID()}`;
		try {
			await mkdir(join(home, "plugins"));
			await writeFile(
				join(home, "settings.json"),
				JSON.stringify({ hooks: { SessionEnd: `SIGNET_API_KEY=${key} signet hook session-end` } }),
			);
			const report = await inspectConnectorFiles([join(home, "settings.json")]);
			expect(report.inlineKeyFiles).toEqual([join(home, "settings.json")]);
			expect(JSON.stringify(report)).not.toContain(key);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);

test("doctor reports a truncated configuration-directory walk", async () => {
	const home = await mkdtemp(join(tmpdir(), "doctor-depth-"));
	try {
		const deep = join(home, "hooks", "one", "two", "three", "four");
		await mkdir(deep, { recursive: true });
		await writeFile(join(deep, "legacy.sh"), "SIGNET_API_KEY=out-of-depth-key");
		const report = await inspectConnectorFiles([join(home, "settings.json")]);
		expect(report).toEqual({ inlineKeyFiles: [], scanIncomplete: true });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
