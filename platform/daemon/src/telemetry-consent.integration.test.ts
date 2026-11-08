import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreshWorkspaceV2, editYamlConfigFile, runMigrations } from "@signet/core";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";

test.each([false, true])(
	"consent gates recording, starts and stops live, and activates once (CLI-created identity: %s)",
	async (cliCreated) => {
		const root = mkdtempSync(join(tmpdir(), "signet-telemetry-live-"));
		const workspace = join(root, "workspace");
		const layout = createFreshWorkspaceV2(workspace);
		writeFileSync(layout.database, "");
		if (cliCreated) {
			const db = new Database(layout.database);
			runMigrations(db);
			db.prepare("INSERT INTO telemetry_install (id, created_at) VALUES (?, ?)").run(
				"cli-install",
				"2020-01-01T00:00:00.000Z",
			);
			db.prepare(
				"INSERT INTO telemetry_events (id, event, timestamp, properties, sent_to_posthog, created_at) VALUES (?, ?, ?, ?, 0, ?)",
			).run("pre-consent", "daemon.heartbeat", "2020-01-01T00:00:00.000Z", "{}", "2020-01-01T00:00:00.000Z");
			db.close();
		}
		const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });
		const port = listener.port;
		listener.stop(true);
		const base = `http://127.0.0.1:${port}`;
		const configPath = join(workspace, "agent.yaml");
		const logPath = join(layout.runtime, "telemetry", "events.jsonl");
		const config = [
			"version: 1",
			"configVersion: 9",
			"embedding:",
			"  provider: none",
			"harnesses: []",
			"capabilities:",
			"  identity:",
			"    mode: off",
			"memory:",
			"  dreaming:",
			"    enabled: false",
			"  pipelineV2:",
			"    enabled: false",
			"    telemetry:",
			"      posthogHost: ''",
			"      flushIntervalMs: 5000",
			"",
		].join("\n");
		writeFileSync(configPath, config);
		const env = {
			...buildHermeticEnvironment({ PATH: process.env.PATH, LANG: "C.UTF-8" }, root),
			HERMES_HOME: join(root, "home", "hermes"),
			SIGNET_PATH: workspace,
			SIGNET_PORT: String(port),
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_DAEMON_ENTRYPOINT: "1",
			SIGNET_EMBEDDING_WARM_NATIVE: "false",
		};
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "daemon.ts")], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const until = async (check: () => boolean | Promise<boolean>) => {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (await check()) return;
				await Bun.sleep(100);
			}
			throw new Error("Daemon consent observation timed out");
		};
		const health = async (): Promise<boolean | null> => {
			try {
				const response = await fetch(`${base}/api/telemetry/health`, { signal: AbortSignal.timeout(1000) });
				return response.ok ? (await response.json()).enabled : null;
			} catch {
				return null;
			}
		};
		try {
			await until(async () => (await health()) === false);
			await Bun.sleep(1000);
			expect(existsSync(logPath)).toBe(false);
			await until(() => {
				const db = new Database(layout.database, { readonly: true });
				db.exec("PRAGMA busy_timeout = 5000");
				const unsent = db.prepare("SELECT COUNT(*) AS count FROM telemetry_events WHERE sent_to_posthog = 0").get() as {
					count: number;
				};
				db.close();
				return unsent.count === 0;
			});
			editYamlConfigFile(configPath, (editor) => editor.set(["memory", "pipelineV2", "telemetryEnabled"], true));
			await until(async () => (await health()) === true && existsSync(logPath));
			await until(() => readFileSync(logPath, "utf8").includes('"event":"install.activated"'));
			expect(readFileSync(logPath, "utf8")).not.toContain('"event":"daemon.started"');
			editYamlConfigFile(configPath, (editor) => editor.set(["memory", "pipelineV2", "telemetryEnabled"], false));
			await until(async () => (await health()) === false);
			await Bun.sleep(300);
			const stopped = readFileSync(logPath, "utf8");
			await Bun.sleep(5500);
			expect(readFileSync(logPath, "utf8")).toBe(stopped);
			editYamlConfigFile(configPath, (editor) => editor.set(["memory", "pipelineV2", "telemetryEnabled"], true));
			await until(async () => (await health()) === true && readFileSync(logPath, "utf8").length > stopped.length);
			expect(
				readFileSync(logPath, "utf8")
					.split("\n")
					.filter((line) => line.includes('"event":"install.activated"')),
			).toHaveLength(1);
			expect(child.exitCode).toBeNull();
		} finally {
			child.kill("SIGTERM");
			const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
			await child.exited;
			clearTimeout(timeout);
			const output = `${await stdout}\n${await stderr}`;
			rmSync(root, { recursive: true, force: true });
			expect(child.exitCode, output).toBe(0);
		}
	},
	90_000,
);
