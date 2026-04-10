import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { getDbAccessor } from "../db-accessor.js";
import { type LogCategory, type LogEntry, logger } from "../logger.js";
import { CRON_PRESETS, computeNextRun, isHarnessAvailable, resolveSkillPrompt, resolveTaskModel, validateCron } from "../scheduler";
import { emitTaskStream, getTaskStreamSnapshot, subscribeTaskStream } from "../scheduler/task-stream.js";
import { readScopedTask, readTaskAgentId } from "../task-scope.js";
import {
	MAX_UPDATE_INTERVAL_SECONDS,
	MIN_UPDATE_INTERVAL_SECONDS,
	checkForUpdates as checkForUpdatesImpl,
	getUpdateState,
	parseBooleanFlag,
	parseUpdateInterval,
	runUpdate as runUpdateImpl,
	setUpdateConfig,
} from "../update-system.js";
import { AGENTS_DIR } from "./state.js";
import { parseOptionalString, resolveScopedAgentId, shouldEnforceAuthScope, toRecord } from "./utils.js";

const MAX_CONFIG_BYTES = 1_048_576;

interface AgentRow {
	id: string;
	name: string;
	read_policy: string;
	policy_group: string | null;
	created_at: string;
	updated_at: string;
}

export function registerMiscRoutes(app: Hono): void {
	app.get("/api/logs", (c) => {
		const limit = Number.parseInt(c.req.query("limit") || "100", 10);
		const level = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
		const category = c.req.query("category") as LogCategory | undefined;
		const sinceRaw = c.req.query("since");
		const since = sinceRaw ? new Date(sinceRaw) : undefined;

		const logs = logger.getRecent({ limit, level, category, since });
		return c.json({ logs, count: logs.length });
	});

	app.get("/api/logs/stream", (c) => {
		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			start(controller) {
				let dead = false;
				const cleanup = () => {
					if (dead) return;
					dead = true;
					logger.off("log", onLog);
					try {
						controller.close();
					} catch {}
				};

				const onLog = (entry: LogEntry) => {
					if (dead) return;
					try {
						const data = `data: ${JSON.stringify(entry)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {
						cleanup();
					}
				};

				logger.on("log", onLog);

				try {
					controller.enqueue(encoder.encode(`data: {"type":"connected"}\n\n`));
				} catch {
					cleanup();
				}

				c.req.raw.signal.addEventListener("abort", cleanup);
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	app.get("/api/config", async (c) => {
		try {
			const files: Array<{ name: string; content: string; size: number }> = [];
			const dirFiles = readdirSync(AGENTS_DIR);
			const configFiles = dirFiles.filter((f) => f.endsWith(".md") || f.endsWith(".yaml"));

			for (const fileName of configFiles) {
				const filePath = join(AGENTS_DIR, fileName);
				const fileStat = statSync(filePath);
				if (fileStat.isFile()) {
					const content = readFileSync(filePath, "utf-8");
					files.push({ name: fileName, content, size: fileStat.size });
				}
			}

			const priority = ["agent.yaml", "AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
			files.sort((a, b) => {
				const aIdx = priority.indexOf(a.name);
				const bIdx = priority.indexOf(b.name);
				if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name);
				if (aIdx === -1) return 1;
				if (bIdx === -1) return -1;
				return aIdx - bIdx;
			});

			return c.json({ files });
		} catch (e) {
			logger.error("api", "Error loading config files", e as Error);
			return c.json({ files: [], error: "Failed to load config files" });
		}
	});

	app.post("/api/config", async (c) => {
		try {
			const { file, content } = await c.req.json();

			if (!file || typeof content !== "string") {
				return c.json({ error: "Invalid request" }, 400);
			}

			if (content.length > MAX_CONFIG_BYTES) {
				return c.json({ error: `content exceeds ${MAX_CONFIG_BYTES} byte limit` }, 413);
			}

			if (file.includes("/") || file.includes("..")) {
				return c.json({ error: "Invalid file name" }, 400);
			}

			if (!file.endsWith(".md") && !file.endsWith(".yaml")) {
				return c.json({ error: "Invalid file type" }, 400);
			}

			writeFileSync(join(AGENTS_DIR, file), content, "utf-8");
			logger.info("api", "Config file updated", { file });
			return c.json({ success: true });
		} catch (e) {
			logger.error("api", "Error saving config file", e as Error);
			return c.json({ error: "Failed to save file" }, 500);
		}
	});

	app.get("/api/identity", (c) => {
		try {
			const content = readFileSync(join(AGENTS_DIR, "IDENTITY.md"), "utf-8");
			const lines = content.split("\n");
			const identity: { name: string; creature: string; vibe: string } = {
				name: "",
				creature: "",
				vibe: "",
			};

			for (const line of lines) {
				if (line.startsWith("- name:")) identity.name = line.replace("- name:", "").trim();
				if (line.startsWith("- creature:")) identity.creature = line.replace("- creature:", "").trim();
				if (line.startsWith("- vibe:")) identity.vibe = line.replace("- vibe:", "").trim();
			}

			return c.json(identity);
		} catch {
			return c.json({ name: "Unknown", creature: "", vibe: "" });
		}
	});

	app.get("/api/agents", (c) => {
		const agents = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents ORDER BY name")
					.all() as AgentRow[],
		);
		return c.json({ agents });
	});

	app.get("/api/agents/:name", (c) => {
		const name = c.req.param("name");
		const agent = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents WHERE name = ?")
					.get(name) as AgentRow | undefined,
		);
		if (!agent) return c.json({ error: "Agent not found" }, 404);
		return c.json(agent);
	});

	app.post("/api/agents", async (c) => {
		const body = toRecord(await c.req.json().catch(() => null));
		if (!body) return c.json({ error: "Invalid JSON body" }, 400);
		const name = parseOptionalString(body.name);
		if (!name) return c.json({ error: "name is required" }, 400);
		const readPolicy = parseOptionalString(body.read_policy) ?? "isolated";
		const group = parseOptionalString(body.policy_group) ?? null;
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run(name, name, readPolicy, group, now, now);
		});
		const created = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, name, read_policy, policy_group, created_at, updated_at FROM agents WHERE id = ?")
					.get(name) as AgentRow,
		);
		return c.json(created, 201);
	});

	app.delete("/api/agents/:name", (c) => {
		const name = c.req.param("name");
		if (name === "default") return c.json({ error: "Cannot remove the default agent" }, 400);
		const purge = c.req.query("purge") === "true";
		const agent = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT id FROM agents WHERE name = ?").get(name) as { id: string } | undefined,
		);
		if (!agent) return c.json({ error: "Agent not found" }, 404);
		getDbAccessor().withWriteTx((db) => {
			if (purge) {
				db.prepare("DELETE FROM memories WHERE agent_id = ?").run(name);
			} else {
				db.prepare("UPDATE memories SET visibility = 'archived' WHERE agent_id = ?").run(name);
			}
			db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
		});
		return c.json({ success: true, purged: purge });
	});

	app.get("/api/update/check", async (c) => {
		const force = c.req.query("force") === "true";
		const us = getUpdateState();

		if (!force && us.lastCheck && us.lastCheckTime) {
			const age = Date.now() - us.lastCheckTime.getTime();
			if (age < 3600000) {
				return c.json({
					...us.lastCheck,
					cached: true,
					checkedAt: us.lastCheckTime.toISOString(),
				});
			}
		}

		const result = await checkForUpdatesImpl();
		const after = getUpdateState();
		return c.json({
			...result,
			cached: false,
			checkedAt: after.lastCheckTime?.toISOString(),
		});
	});

	app.get("/api/update/config", (c) => {
		const us = getUpdateState();
		return c.json({
			...us.config,
			minInterval: MIN_UPDATE_INTERVAL_SECONDS,
			maxInterval: MAX_UPDATE_INTERVAL_SECONDS,
			pendingRestartVersion: us.pendingRestartVersion,
			lastAutoUpdateAt: us.lastAutoUpdateAt?.toISOString(),
			lastAutoUpdateError: us.lastAutoUpdateError,
			updateInProgress: us.installInProgress,
		});
	});

	app.post("/api/update/config", async (c) => {
		type UpdateConfigBody = Partial<{
			autoInstall: boolean | string;
			auto_install: boolean | string;
			checkInterval: number | string;
			check_interval: number | string;
		}>;

		const body = (await c.req.json()) as UpdateConfigBody;
		const autoInstallRaw = body.autoInstall ?? body.auto_install;
		const checkIntervalRaw = body.checkInterval ?? body.check_interval;

		let autoInstall: boolean | undefined;
		let checkInterval: number | undefined;

		if (autoInstallRaw !== undefined) {
			const parsed = parseBooleanFlag(autoInstallRaw);
			if (parsed === null) {
				return c.json({ success: false, error: "autoInstall must be true or false" }, 400);
			}
			autoInstall = parsed;
		}

		if (checkIntervalRaw !== undefined) {
			const parsed = parseUpdateInterval(checkIntervalRaw);
			if (parsed === null) {
				return c.json(
					{
						success: false,
						error: `checkInterval must be between ${MIN_UPDATE_INTERVAL_SECONDS} and ${MAX_UPDATE_INTERVAL_SECONDS} seconds`,
					},
					400,
				);
			}
			checkInterval = parsed;
		}

		const changed = autoInstall !== undefined || checkInterval !== undefined;
		let persisted = true;

		if (changed) {
			const result = setUpdateConfig({ autoInstall, checkInterval });
			persisted = result.persisted;
		}

		const us = getUpdateState();
		return c.json({
			success: true,
			config: us.config,
			persisted,
			pendingRestartVersion: us.pendingRestartVersion,
			lastAutoUpdateAt: us.lastAutoUpdateAt?.toISOString(),
			lastAutoUpdateError: us.lastAutoUpdateError,
		});
	});

	app.post("/api/update/run", async (c) => {
		let targetVersion: string | undefined;

		try {
			const body = await c.req.json<{ targetVersion?: string }>();
			if (body.targetVersion && typeof body.targetVersion === "string") {
				targetVersion = body.targetVersion;
			}
		} catch {
			// No body or invalid JSON — fall through to check
		}

		if (!targetVersion) {
			const check = await checkForUpdatesImpl();

			if (check.restartRequired && !check.updateAvailable) {
				return c.json({
					success: true,
					message: `Update ${check.pendingVersion || check.latestVersion || "already"} installed. Restart daemon to apply.`,
					installedVersion: check.pendingVersion || check.latestVersion,
					restartRequired: true,
				});
			}

			if (!check.updateAvailable && check.latestVersion) {
				return c.json({
					success: true,
					message: "Already running the latest version.",
					installedVersion: check.latestVersion,
					restartRequired: false,
				});
			}

			targetVersion = check.latestVersion ?? undefined;
		}

		const result = await runUpdateImpl(targetVersion);
		return c.json(result);
	});

	app.get("/api/tasks/:id/stream", (c) => {
		const taskId = c.req.param("id");

		const taskExists = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT 1 FROM scheduled_tasks WHERE id = ?").get(taskId),
		);

		if (!taskExists) {
			return c.json({ error: "Task not found" }, 404);
		}

		const encoder = new TextEncoder();

		const stream = new ReadableStream({
			start(controller) {
				let dead = false;
				const cleanup = () => {
					if (dead) return;
					dead = true;
					clearInterval(keepAlive);
					unsubscribe();
				};

				const writeEvent = (event: unknown) => {
					if (dead) return;
					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {
						cleanup();
					}
				};

				writeEvent({
					type: "connected",
					taskId,
					timestamp: new Date().toISOString(),
				});

				const snapshot = getTaskStreamSnapshot(taskId);
				if (snapshot) {
					writeEvent({
						type: "run-started",
						taskId,
						runId: snapshot.runId,
						startedAt: snapshot.startedAt,
						timestamp: new Date().toISOString(),
					});

					for (const chunk of snapshot.stdoutChunks) {
						writeEvent({
							type: "run-output",
							taskId,
							runId: snapshot.runId,
							stream: "stdout",
							chunk,
							timestamp: new Date().toISOString(),
						});
					}

					for (const chunk of snapshot.stderrChunks) {
						writeEvent({
							type: "run-output",
							taskId,
							runId: snapshot.runId,
							stream: "stderr",
							chunk,
							timestamp: new Date().toISOString(),
						});
					}
				}

				const unsubscribe = subscribeTaskStream(taskId, (event) => {
					writeEvent(event);
				});

				const keepAlive = setInterval(() => {
					if (dead) return;
					try {
						controller.enqueue(encoder.encode(": keepalive\n\n"));
					} catch {
						cleanup();
					}
				}, 15_000);

				c.req.raw.signal.addEventListener("abort", cleanup);
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	app.get("/api/tasks", (c) => {
		const tasks = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT t.*,
					        r.status AS last_run_status,
					        r.exit_code AS last_run_exit_code
					 FROM scheduled_tasks t
					 LEFT JOIN task_runs r ON r.id = (
					     SELECT id FROM task_runs
					     WHERE task_id = t.id
					     ORDER BY started_at DESC LIMIT 1
					 )
					 ORDER BY t.created_at DESC`,
				)
				.all(),
		);

		return c.json({ tasks, presets: CRON_PRESETS });
	});

	app.post("/api/tasks", async (c) => {
		const scoped = resolveScopedAgentId(c, c.req.query("agent_id"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);

		const body = await c.req.json();
		const { name, prompt, cronExpression, harness, workingDirectory, skillName, skillMode } = body;

		if (!name || !prompt || !cronExpression || !harness) {
			return c.json({ error: "name, prompt, cronExpression, and harness are required" }, 400);
		}

		if (!validateCron(cronExpression)) {
			return c.json({ error: "Invalid cron expression" }, 400);
		}

		if (harness !== "claude-code" && harness !== "opencode" && harness !== "codex") {
			return c.json({ error: "harness must be 'claude-code', 'codex', or 'opencode'" }, 400);
		}

		if (skillName && (skillName.includes("/") || skillName.includes(".."))) {
			return c.json({ error: "Invalid skill name" }, 400);
		}

		if (skillName && skillMode !== "inject" && skillMode !== "slash") {
			return c.json({ error: "skillMode must be 'inject' or 'slash' when skillName is set" }, 400);
		}

		if (!isHarnessAvailable(harness)) {
			return c.json(
				{
					error: `CLI for ${harness} not found on PATH`,
					warning: true,
				},
				400,
			);
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const nextRunAt = computeNextRun(cronExpression);

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO scheduled_tasks
				 (id, name, prompt, cron_expression, harness, working_directory,
				  enabled, next_run_at, skill_name, skill_mode, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
			).run(
				id,
				name,
				prompt,
				cronExpression,
				harness,
				workingDirectory || null,
				nextRunAt,
				skillName || null,
				skillMode || null,
				now,
				now,
			);
			db.prepare(
				`INSERT INTO task_scope_hints (task_id, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(task_id) DO UPDATE SET agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
			).run(id, scoped.agentId, now, now);
		});

		logger.info("scheduler", `Task created: ${name}`, { taskId: id });
		return c.json({ id, nextRunAt }, 201);
	});

	app.get("/api/tasks/:id", (c) => {
		const taskId = c.req.param("id");

		const task = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId),
		);

		if (!task) {
			return c.json({ error: "Task not found" }, 404);
		}

		const runs = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT * FROM task_runs
					 WHERE task_id = ?
					 ORDER BY started_at DESC
					 LIMIT 20`,
				)
				.all(taskId),
		);

		return c.json({ task, runs });
	});

	app.patch("/api/tasks/:id", async (c) => {
		const taskId = c.req.param("id");
		const body = await c.req.json();

		const existing = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId),
		) as Record<string, unknown> | undefined;

		if (!existing) {
			return c.json({ error: "Task not found" }, 404);
		}

		if (body.cronExpression !== undefined && !validateCron(body.cronExpression)) {
			return c.json({ error: "Invalid cron expression" }, 400);
		}

		const now = new Date().toISOString();
		const cronExpr = body.cronExpression ?? existing.cron_expression;
		const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
		const nextRunAt =
			body.cronExpression !== undefined || body.enabled !== undefined
				? enabled
					? computeNextRun(cronExpr as string)
					: existing.next_run_at
				: existing.next_run_at;

		const skillName = body.skillName !== undefined ? body.skillName || null : existing.skill_name;
		const skillMode = body.skillMode !== undefined ? body.skillMode || null : existing.skill_mode;

		if (skillName && (skillName.includes("/") || skillName.includes(".."))) {
			return c.json({ error: "Invalid skill name" }, 400);
		}

		if (skillName && skillMode !== null && skillMode !== "inject" && skillMode !== "slash") {
			return c.json({ error: "skillMode must be 'inject' or 'slash' when skillName is set" }, 400);
		}

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE scheduled_tasks SET
				 name = ?, prompt = ?, cron_expression = ?, harness = ?,
				 working_directory = ?, enabled = ?, next_run_at = ?,
				 skill_name = ?, skill_mode = ?, updated_at = ?
				 WHERE id = ?`,
			).run(
				body.name ?? existing.name,
				body.prompt ?? existing.prompt,
				cronExpr,
				body.harness ?? existing.harness,
				body.workingDirectory !== undefined ? body.workingDirectory : existing.working_directory,
				enabled,
				nextRunAt,
				skillName,
				skillMode,
				now,
				taskId,
			);
		});

		return c.json({ success: true });
	});

	app.delete("/api/tasks/:id", (c) => {
		const taskId = c.req.param("id");

		const result = getDbAccessor().withWriteTx((db) => {
			const info = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(taskId);
			return info;
		});

		return c.json({ success: true });
	});

	app.post("/api/tasks/:id/run", async (c) => {
		const taskId = c.req.param("id");
		const scoped = resolveScopedAgentId(c, c.req.query("agent_id"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);

		const task = getDbAccessor().withReadDb((db) =>
			readScopedTask(db, taskId, scoped.agentId, shouldEnforceAuthScope(c)),
		);

		if (!task) {
			return c.json({ error: "Task not found" }, 404);
		}

		const running = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? AND status = 'running' LIMIT 1").get(taskId),
		);

		if (running) {
			return c.json({ error: "Task is already running" }, 409);
		}

		const runId = crypto.randomUUID();
		const now = new Date().toISOString();

		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO task_runs (id, task_id, status, started_at)
				 VALUES (?, ?, 'running', ?)`,
			).run(runId, taskId, now);

			db.prepare("UPDATE scheduled_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?").run(now, now, taskId);
		});

		emitTaskStream({
			type: "run-started",
			taskId,
			runId,
			startedAt: now,
			timestamp: new Date().toISOString(),
		});

		const taskPrompt = typeof task.prompt === "string" ? task.prompt : null;
		const taskHarness =
			task.harness === "claude-code" || task.harness === "opencode" || task.harness === "codex" ? task.harness : null;
		if (!taskPrompt || !taskHarness) {
			return c.json({ error: "Task has invalid prompt or harness" }, 500);
		}
		const taskSkillName = typeof task.skill_name === "string" ? task.skill_name : null;
		const taskSkillMode = typeof task.skill_mode === "string" ? task.skill_mode : null;
		const taskWorkingDir = typeof task.working_directory === "string" ? task.working_directory : null;
		const taskAgentId = readTaskAgentId(task, scoped.agentId);
		const taskModel = taskHarness === "claude-code" || taskHarness === "codex" ? resolveTaskModel(taskHarness) : undefined;

		const effectivePrompt = resolveSkillPrompt(taskPrompt, taskSkillName, taskSkillMode);
		const startedMs = Date.now();

		import("../scheduler/spawn.js").then((mod) => {
			mod
				.spawnTask(
					taskHarness,
					effectivePrompt,
					taskWorkingDir,
					undefined,
					{
						onStdoutChunk: (chunk) => {
							emitTaskStream({
								type: "run-output",
								taskId,
								runId,
								stream: "stdout",
								chunk,
								timestamp: new Date().toISOString(),
							});
						},
						onStderrChunk: (chunk) => {
							emitTaskStream({
								type: "run-output",
								taskId,
								runId,
								stream: "stderr",
								chunk,
								timestamp: new Date().toISOString(),
							});
						},
					},
					taskModel,
				)
				.then((result) => {
					const completedAt = new Date().toISOString();
					const status =
						result.error !== null || (result.exitCode !== null && result.exitCode !== 0) ? "failed" : "completed";

					getDbAccessor().withWriteTx((db) => {
						db.prepare(
							`UPDATE task_runs
						 SET status = ?, completed_at = ?, exit_code = ?,
						     stdout = ?, stderr = ?, error = ?
						 WHERE id = ?`,
						).run(status, completedAt, result.exitCode, result.stdout, result.stderr, result.error, runId);
					});

					emitTaskStream({
						type: "run-completed",
						taskId,
						runId,
						status,
						completedAt,
						exitCode: result.exitCode,
						error: result.error,
						timestamp: new Date().toISOString(),
					});

					if (taskSkillName) {
						void import("../skill-invocations.js").then((skills) => {
							skills.recordSkillInvocation({
								skillName: taskSkillName,
								agentId: taskAgentId,
								source: "api",
								latencyMs: Date.now() - startedMs,
								success: status === "completed",
								errorText: result.error ?? undefined,
							});
						});
					}
				});
		});

		return c.json({ runId, status: "running" }, 202);
	});

	app.get("/api/tasks/:id/runs", (c) => {
		const taskId = c.req.param("id");
		const limit = Number(c.req.query("limit") ?? 20);
		const offset = Number(c.req.query("offset") ?? 0);

		const runs = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT * FROM task_runs
					 WHERE task_id = ?
					 ORDER BY started_at DESC
					 LIMIT ? OFFSET ?`,
				)
				.all(taskId, limit, offset),
		);

		const total = getDbAccessor().withReadDb((db) => {
			const row = db.prepare("SELECT COUNT(*) as count FROM task_runs WHERE task_id = ?").get(taskId) as {
				count: number;
			};
			return row.count;
		});

		return c.json({ runs, total, hasMore: offset + limit < total });
	});
}
