import { confirm, password } from "@inquirer/prompts";
import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";

interface SecretDeps {
	readonly ensureDaemonForSecrets: () => Promise<boolean>;
	readonly secretApiCall: (
		method: string,
		path: string,
		body?: unknown,
		timeoutMs?: number,
	) => Promise<{
		ok: boolean;
		data: unknown;
	}>;
}

function append(value: string, previous: string[]): string[] {
	return [...previous, value];
}

async function readSecretFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}

export function registerSecretCommands(program: Command, deps: SecretDeps): void {
	const secretCmd = program.command("secret").description("Manage encrypted secrets").enablePositionalOptions();

	secretCmd
		.command("put <name> [value]")
		.description("Store a secret (prompted if value omitted)")
		.action(async (name: string, rawValue?: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;

			const value = rawValue ?? (await password({ message: `Enter value for ${chalk.bold(name)}:`, mask: "•" }));
			if (!value) {
				console.error(chalk.red("  Value cannot be empty"));
				process.exit(1);
			}

			const spinner = ora("Saving secret...").start();
			try {
				const { ok, data } = await deps.secretApiCall("POST", `/api/secrets/${name}`, { value });
				if (ok) {
					spinner.succeed(chalk.green(`Secret ${chalk.bold(name)} saved`));
					return;
				}
				spinner.fail(chalk.red(`Failed: ${readError(data)}`));
				process.exit(1);
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	secretCmd
		.command("list")
		.description("List secret names (never values)")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { ok, data } = await deps.secretApiCall("GET", "/api/secrets");
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exit(1);
				}
				const secrets = readStringArray(data, "secrets");
				if (secrets.length === 0) {
					console.log(chalk.dim("  No secrets stored."));
					return;
				}
				for (const name of secrets) {
					console.log(`  ${chalk.cyan("◈")} ${name}`);
				}
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	secretCmd
		.command("delete <name>")
		.description("Delete a secret")
		.action(async (name: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const confirmed = await confirm({ message: `Delete secret ${chalk.bold(name)}?`, default: false });
			if (!confirmed) return;
			const spinner = ora("Deleting...").start();
			try {
				const { ok, data } = await deps.secretApiCall("DELETE", `/api/secrets/${name}`);
				if (ok) {
					spinner.succeed(chalk.green(`Secret ${chalk.bold(name)} deleted`));
					return;
				}
				spinner.fail(chalk.red(`Failed: ${readError(data)}`));
				process.exit(1);
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	secretCmd
		.command("get <name>")
		.description("Explain how to use a secret (values are never exposed)")
		.action(async (name: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { ok, data } = await deps.secretApiCall("GET", "/api/secrets");
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exit(1);
				}
				const exists = readStringArray(data, "secrets").includes(name);
				if (!exists) {
					console.error(chalk.red(`\n  Secret "${chalk.bold(name)}" not found.\n`));
					console.error(chalk.dim("  Store it with:"));
					console.error(`    signet secret put ${name}\n`);
					process.exit(1);
				}

				console.log(chalk.yellow(`\n  Secret "${chalk.bold(name)}" exists, but values are never exposed directly.`));
				console.log(chalk.dim("\n  Signet secrets are injected at runtime, not read from disk."));
				console.log(chalk.dim("  Use one of the following:\n"));
				console.log(chalk.dim("  In a command (injected as env var):"));
				console.log(`    signet secret exec --secret ${name} "your-command-here"\n`);
				console.log(chalk.dim("  In agent.yaml (resolved by the daemon):"));
				console.log(`    api_key: $secret:${name}\n`);
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	secretCmd
		.command("exec <command...>")
		.description(
			"Queue a command with secrets injected as environment variables\n" +
				"  NOTE: --secret flags must appear before the command token.\n" +
				"  Secrets are available via process.env / os.environ in the subprocess;\n" +
				"  shell-level $VAR expansion is intentionally disabled for security.",
		)
		.passThroughOptions()
		.option("-s, --secret <name>", "Secret to inject (repeatable, must precede command)", append, [] as string[])
		.option("--timeout <seconds>", "Maximum subprocess runtime before Signet terminates it", "300")
		.action(async (parts: string[], opts: { secret: string[]; timeout: string }) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			if (opts.secret.length === 0) {
				console.error(chalk.red("  At least one --secret is required."));
				console.log(chalk.dim("  NOTE: --secret flags must come before the command token."));
				console.log(chalk.dim("\n  Example:"));
				console.log("    signet secret exec --secret OPENAI_API_KEY curl https://api.openai.com/v1/models\n");
				process.exit(1);
			}

			const valid = /^[A-Za-z_][A-Za-z0-9_]*$/;
			for (const name of opts.secret) {
				if (valid.test(name)) continue;
				console.error(chalk.red(`  Invalid secret name for env injection: "${name}"`));
				console.log(
					chalk.dim(
						"  Names must be valid env var identifiers: letters, digits, underscore; no leading digit or hyphens.",
					),
				);
				process.exitCode = 1;
				return;
			}

			const secrets: Record<string, string> = {};
			for (const name of opts.secret) {
				secrets[name] = name;
			}

			const command = parts
				.map((arg) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$")}"`)
				.join(" ");

			const timeoutSeconds = Number.parseInt(opts.timeout, 10);
			if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
				console.error(chalk.red("  --timeout must be a positive number of seconds."));
				process.exitCode = 1;
				return;
			}
			const timeoutMs = timeoutSeconds * 1000;
			const requestTimeoutMs = 10_000;

			try {
				const { ok, data } = await deps.secretApiCall(
					"POST",
					"/api/secrets/exec",
					{ command, secrets, timeoutMs },
					requestTimeoutMs,
				);
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exitCode = 1;
					return;
				}

				const jobId = readString(data, "id");
				const status = readString(data, "status") ?? "queued";
				console.log(`Secret exec queued: ${chalk.cyan(jobId ?? "unknown")}`);
				console.log(chalk.dim(`Status: ${status}`));
				console.log(chalk.dim(`Poll with: signet secret exec-status ${jobId}`));
			} catch (err) {
				if (err instanceof Error && err.name === "TimeoutError") {
					console.error(
						chalk.red(`  Error: daemon request timed out after ${Math.round(requestTimeoutMs / 1000)} seconds.`),
					);
					console.error(
						chalk.dim("  The daemon queues secret exec jobs; retry or poll the queued job if one was returned."),
					);
				} else {
					console.error(chalk.red(`  Error: ${readThrown(err)}`));
				}
				process.exitCode = 1;
			}
		});

	secretCmd
		.command("exec-status <jobId>")
		.description("Check an asynchronous secret exec job")
		.action(async (jobId: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { ok, data } = await deps.secretApiCall("GET", `/api/secrets/exec/${jobId}`, undefined, 10_000);
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exitCode = 1;
					return;
				}
				const status = readString(data, "status") ?? "unknown";
				console.log(`Status: ${status}`);
				const result = readRecord(readRecord(data)?.result);
				if (result) {
					const stdout = readString(result, "stdout");
					const stderr = readString(result, "stderr");
					const code = readNumber(result, "code");
					if (stdout) process.stdout.write(stdout);
					if (stderr) process.stderr.write(stderr);
					process.exitCode = code ?? 1;
				}
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exitCode = 1;
			}
		});

	secretCmd
		.command("has <name>")
		.description("Check if a secret exists (exits 0 if found, 1 if not)")
		.action(async (name: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { data } = await deps.secretApiCall("GET", "/api/secrets");
				const exists = readStringArray(data, "secrets").includes(name);
				console.log(exists ? "true" : "false");
				process.exit(exists ? 0 : 1);
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	const onePasswordCmd = secretCmd.command("onepassword").alias("op").description("Manage 1Password integration");

	onePasswordCmd
		.command("connect [token]")
		.description("Connect 1Password using a service account token")
		.action(async (rawToken?: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const token = rawToken ?? (await password({ message: "1Password service account token:", mask: "•" }));
			if (!token) {
				console.error(chalk.red("  Token cannot be empty"));
				process.exit(1);
			}
			const spinner = ora("Connecting to 1Password...").start();
			try {
				const { ok, data } = await deps.secretApiCall("POST", "/api/secrets/1password/connect", { token });
				if (!ok) {
					spinner.fail(chalk.red(`Failed: ${readError(data)}`));
					process.exit(1);
				}
				const count = readNumber(data, "vaultCount") ?? 0;
				spinner.succeed(chalk.green(`Connected to 1Password (${count} vaults accessible)`));
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	onePasswordCmd
		.command("status")
		.description("Show 1Password connection status")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { ok, data } = await deps.secretApiCall("GET", "/api/secrets/1password/status");
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exit(1);
				}
				const configured = readBoolean(data, "configured");
				const connected = readBoolean(data, "connected");
				const count = readNumber(data, "vaultCount") ?? 0;
				const error = readString(data, "error");
				if (!configured) {
					console.log(chalk.dim("  1Password is not connected."));
					console.log(chalk.dim("  Run: signet secret onepassword connect"));
					return;
				}
				if (connected) {
					console.log(chalk.green("  Connected to 1Password"));
					console.log(chalk.dim(`  Accessible vaults: ${count}`));
					return;
				}
				console.log(chalk.yellow("  1Password token is configured but not usable."));
				if (error) console.log(chalk.dim(`  ${error}`));
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	onePasswordCmd
		.command("vaults")
		.description("List accessible 1Password vaults")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { ok, data } = await deps.secretApiCall("GET", "/api/secrets/1password/vaults");
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exit(1);
				}
				const vaults = readVaults(data);
				if (vaults.length === 0) {
					console.log(chalk.dim("  No vaults available."));
					return;
				}
				for (const vault of vaults) {
					console.log(`  ${chalk.cyan("◈")} ${vault.name} ${chalk.dim(`(${vault.id})`)}`);
				}
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	onePasswordCmd
		.command("import")
		.description("Import password-like fields from 1Password into Signet secrets")
		.option("-v, --vault <vault>", "Vault ID or exact name (repeatable)", append, [] as string[])
		.option("--prefix <prefix>", "Prefix for imported secret names", "OP")
		.option("--overwrite", "Overwrite existing Signet secrets with the same name", false)
		.option("--token <token>", "Use token for this import without saving it")
		.action(async (options: { vault: string[]; prefix: string; overwrite: boolean; token?: string }) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const spinner = ora("Importing from 1Password...").start();
			try {
				const { ok, data } = await deps.secretApiCall("POST", "/api/secrets/1password/import", {
					token: options.token,
					vaults: options.vault.length > 0 ? options.vault : undefined,
					prefix: options.prefix,
					overwrite: options.overwrite,
				});
				if (!ok) {
					spinner.fail(chalk.red(`Failed: ${readError(data)}`));
					process.exit(1);
				}
				const imported = readNumber(data, "importedCount") ?? 0;
				const skipped = readNumber(data, "skippedCount") ?? 0;
				const errors = readNumber(data, "errorCount") ?? 0;
				spinner.succeed(chalk.green(`Imported ${imported} secrets (skipped ${skipped}, errors ${errors})`));
				for (const item of readImportErrors(data).slice(0, 3)) {
					console.log(chalk.dim(`  - ${item.itemTitle}: ${item.error}`));
				}
				const extra = readImportErrors(data).length - 3;
				if (extra > 0) console.log(chalk.dim(`  ...and ${extra} more`));
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	onePasswordCmd
		.command("disconnect")
		.description("Disconnect 1Password and remove stored service account token")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const confirmed = await confirm({ message: "Disconnect 1Password integration?", default: false });
			if (!confirmed) return;
			const spinner = ora("Disconnecting 1Password...").start();
			try {
				const { ok, data } = await deps.secretApiCall("DELETE", "/api/secrets/1password/connect");
				if (!ok) {
					spinner.fail(chalk.red(`Failed: ${readError(data)}`));
					process.exit(1);
				}
				spinner.succeed(chalk.green("1Password disconnected"));
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	const bitwardenCmd = secretCmd.command("bitwarden").alias("bw").description("Manage Bitwarden integration");

	bitwardenCmd
		.command("connect")
		.allowExcessArguments(false)
		.description("Connect Bitwarden using a `bw unlock --raw` session token")
		.option("--activate", "Use Bitwarden as the active Signet secrets provider after connecting", false)
		.option("--folder <folderId>", "Folder id for Signet-managed Bitwarden items")
		.option("--session-stdin", "Read the Bitwarden session token from stdin instead of prompting", false)
		.action(async (options: { activate: boolean; folder?: string; sessionStdin: boolean }) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const session = options.sessionStdin
				? await readSecretFromStdin()
				: await password({ message: "Bitwarden session token (`bw unlock --raw`):", mask: "•" });
			if (!session) {
				console.error(chalk.red("  Session token cannot be empty"));
				process.exit(1);
			}
			const spinner = ora("Connecting to Bitwarden...").start();
			try {
				const { ok, data } = await deps.secretApiCall("POST", "/api/secrets/bitwarden/connect", {
					session,
					activate: options.activate,
					folderId: options.folder,
				});
				if (!ok) {
					spinner.fail(chalk.red(`Failed: ${readError(data)}`));
					process.exit(1);
				}
				const connected = readBoolean(data, "connected");
				const active = readBoolean(data, "activeProvider");
				spinner.succeed(
					chalk.green(
						`Bitwarden connected${active ? " and active" : ""}${connected ? "" : " (session saved, status degraded)"}`,
					),
				);
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	bitwardenCmd
		.command("status")
		.description("Show Bitwarden connection and provider status")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			try {
				const { ok, data } = await deps.secretApiCall("GET", "/api/secrets/bitwarden/status");
				if (!ok) {
					console.error(chalk.red(`  Error: ${readError(data)}`));
					process.exit(1);
				}
				const configured = readBoolean(data, "configured");
				const connected = readBoolean(data, "connected");
				const active = readBoolean(data, "activeProvider");
				const error = readString(data, "error");
				if (!configured) {
					console.log(chalk.dim("  Bitwarden is not connected."));
					console.log(
						chalk.dim("  Run: bw login && bw unlock --raw | signet secret bitwarden connect --session-stdin"),
					);
					return;
				}
				console.log(
					connected
						? chalk.green("  Connected to Bitwarden")
						: chalk.yellow("  Bitwarden session is configured but not usable."),
				);
				console.log(chalk.dim(`  Active provider: ${active ? "bitwarden" : "local"}`));
				if (error) console.log(chalk.dim(`  ${error}`));
			} catch (err) {
				console.error(chalk.red(`  Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	bitwardenCmd
		.command("use <provider>")
		.description("Switch active Signet secret provider: local or bitwarden")
		.action(async (provider: string) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			if (provider !== "local" && provider !== "bitwarden") {
				console.error(chalk.red("  Provider must be 'local' or 'bitwarden'."));
				process.exit(1);
			}
			const { ok, data } = await deps.secretApiCall("POST", "/api/secrets/bitwarden/provider", { provider });
			if (!ok) {
				console.error(chalk.red(`  Error: ${readError(data)}`));
				process.exit(1);
			}
			console.log(chalk.green(`  Active secret provider: ${provider}`));
		});

	bitwardenCmd
		.command("folders")
		.description("List Bitwarden folders")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const { ok, data } = await deps.secretApiCall("GET", "/api/secrets/bitwarden/folders");
			if (!ok) {
				console.error(chalk.red(`  Error: ${readError(data)}`));
				process.exit(1);
			}
			for (const folder of readFolders(data)) {
				console.log(`  ${chalk.cyan("◈")} ${folder.name} ${chalk.dim(`(${folder.id})`)}`);
			}
		});

	bitwardenCmd
		.command("migrate")
		.description("Copy existing local Signet secrets into Bitwarden")
		.option("--write", "Actually migrate. Without this, Signet performs a dry run", false)
		.option("--delete-local", "Delete local copies after successful migration", false)
		.option("--overwrite", "Overwrite existing Bitwarden items with the same name", false)
		.option("--folder <folderId>", "Bitwarden folder id to place migrated secrets in")
		.action(async (options: { write: boolean; deleteLocal: boolean; overwrite: boolean; folder?: string }) => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			if (options.deleteLocal && !options.write) {
				console.error(chalk.red("  --delete-local requires --write."));
				process.exit(1);
			}
			if (options.deleteLocal) {
				const confirmed = await confirm({
					message: "Delete local Signet copies after migrating to Bitwarden?",
					default: false,
				});
				if (!confirmed) return;
			}
			const spinner = ora(
				options.write ? "Migrating local secrets to Bitwarden..." : "Dry-running Bitwarden migration...",
			).start();
			try {
				const { ok, data } = await deps.secretApiCall("POST", "/api/secrets/bitwarden/migrate", {
					dryRun: !options.write,
					deleteLocal: options.deleteLocal,
					overwrite: options.overwrite,
					folderId: options.folder,
				});
				if (!ok) {
					spinner.fail(chalk.red(`Failed: ${readError(data)}`));
					process.exit(1);
				}
				const migrated = readNumber(data, "migratedCount") ?? 0;
				const skipped = readNumber(data, "skippedCount") ?? 0;
				const errors = readNumber(data, "errorCount") ?? 0;
				spinner.succeed(
					chalk.green(
						`${options.write ? "Migrated" : "Would migrate"} ${migrated} secrets (skipped ${skipped}, errors ${errors})`,
					),
				);
				if (!options.write) console.log(chalk.dim("  Re-run with --write to copy secrets into Bitwarden."));
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});

	bitwardenCmd
		.command("disconnect")
		.description("Disconnect Bitwarden and return to the local Signet secret provider")
		.action(async () => {
			if (!(await deps.ensureDaemonForSecrets())) return;
			const confirmed = await confirm({ message: "Disconnect Bitwarden integration?", default: false });
			if (!confirmed) return;
			const spinner = ora("Disconnecting Bitwarden...").start();
			try {
				const { ok, data } = await deps.secretApiCall("DELETE", "/api/secrets/bitwarden/connect");
				if (!ok) {
					spinner.fail(chalk.red(`Failed: ${readError(data)}`));
					process.exit(1);
				}
				spinner.succeed(chalk.green("Bitwarden disconnected; local Signet secrets remain available"));
			} catch (err) {
				spinner.fail(chalk.red(`Error: ${readThrown(err)}`));
				process.exit(1);
			}
		});
}

function readRecord(data: unknown): Record<string, unknown> | null {
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function readError(data: unknown): string {
	const record = readRecord(data);
	const value = record?.error;
	return typeof value === "string" && value.length > 0 ? value : "Request failed";
}

function readThrown(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

function readString(data: unknown, key: string): string {
	const value = readRecord(data)?.[key];
	return typeof value === "string" ? value : "";
}

function readNumber(data: unknown, key: string): number | null {
	const value = readRecord(data)?.[key];
	return typeof value === "number" ? value : null;
}

function readBoolean(data: unknown, key: string): boolean {
	return readRecord(data)?.[key] === true;
}

function readStringArray(data: unknown, key: string): string[] {
	const value = readRecord(data)?.[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readVaults(data: unknown): Array<{ id: string; name: string }> {
	const value = readRecord(data)?.vaults;
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const record = readRecord(item);
		const id = typeof record?.id === "string" ? record.id : null;
		const name = typeof record?.name === "string" ? record.name : null;
		return id && name ? [{ id, name }] : [];
	});
}

function readFolders(data: unknown): Array<{ id: string; name: string }> {
	const value = readRecord(data)?.folders;
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const record = readRecord(item);
		const id = typeof record?.id === "string" ? record.id : null;
		const name = typeof record?.name === "string" ? record.name : null;
		return id && name ? [{ id, name }] : [];
	});
}

function readImportErrors(data: unknown): Array<{ itemTitle: string; error: string }> {
	const value = readRecord(data)?.errors;
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const record = readRecord(item);
		const itemTitle = typeof record?.itemTitle === "string" ? record.itemTitle : null;
		const error = typeof record?.error === "string" ? record.error : null;
		return itemTitle && error ? [{ itemTitle, error }] : [];
	});
}
