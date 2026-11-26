import { readSecretFromStdin } from "../lib/stdin-secret.js";
import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { hostname, platform } from "node:os";
import { CommanderError, type Command } from "commander";
import open from "open";
import {
	SignetApiError,
	SignetError,
	SignetForbiddenError,
	SignetTransport,
	SignetUnauthorizedError,
} from "../../../../libs/sdk/src/index.js";
import {
	LoginStore,
	NodeTransport,
	resolveTarget,
	type ResolveTargetOptions,
	type ResolvedTarget,
} from "../../../../libs/sdk/src/node.js";
import { cliTarget, cliTransport } from "../lib/organization-target.js";

export interface AuthCommandDeps extends ResolveTargetOptions {
	readonly print?: (value: string) => void;
	readonly openBrowser?: (url: string) => Promise<unknown>;
	readonly saveUrl?: (url: string) => Promise<void>;
	readonly afterLogin?: (context: LoginOnboardingContext) => Promise<unknown>;
}
export interface LoginOnboardingContext {
	readonly target: ResolvedTarget;
	readonly transport: NodeTransport;
	readonly options: ResolveTargetOptions;
	readonly json: boolean;
}
interface AuthOptions {
	issuer?: string;
	clientId?: string;
	clientSecretRef?: string;
	clientSecretStdin?: boolean;
	url?: string;
	json?: boolean;
	all?: boolean;
	deviceCode?: boolean;
	nonInteractive?: boolean;
}
interface DeviceStart {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	interval: number;
	expiresIn: number;
}
interface DeviceToken {
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: string;
	refreshExpiresAt: string;
}

export function reportAuthError(
	error: unknown,
	json = false,
	unauthorizedMessage = "Signet session expired, run `signet login`",
): void {
	const status = error instanceof SignetApiError ? error.status : 0;
	const reason =
		error instanceof SignetUnauthorizedError || error instanceof SignetForbiddenError
			? error.reason
			: error instanceof SignetError
				? error.code
				: error instanceof CommanderError
					? "invalid_arguments"
					: "request_failed";
	const target = cliTarget();
	const expiredMessage =
		target?.remote && unauthorizedMessage === "Signet session expired, run `signet login`"
			? `Session expired for \`${new URL(target.url).hostname}\`. Run \`signet login\`.`
			: unauthorizedMessage;
	const message =
		status === 401
			? expiredMessage
			: error instanceof SignetForbiddenError && error.required
				? error.required
				: error instanceof Error
					? error.message
					: "Signet request failed";
	process.stderr.write(
		`${json ? JSON.stringify({ error: message, reason, status, ...(error instanceof SignetForbiddenError && error.required ? { required: error.required } : {}) }) : message}\n`,
	);
	process.exitCode = status === 401 ? 3 : status === 403 ? 4 : 1;
}
export async function authTransport(options: AuthOptions, deps: AuthCommandDeps = {}): Promise<NodeTransport> {
	const selected = cliTransport();
	if (selected) return selected;
	return new NodeTransport(await resolveTarget({ ...deps, flagUrl: options.url ?? deps.flagUrl }), { env: deps.env });
}
function loginTarget(options: AuthOptions, deps: AuthCommandDeps): { url: string; origin: string } {
	const env = deps.env ?? process.env;
	const url = resolveSignetDaemonUrl({
		env: { ...env, SIGNET_DAEMON_URL: options.url ?? cliTarget()?.url ?? deps.flagUrl ?? env.SIGNET_DAEMON_URL },
		configUrl: deps.configUrl,
	});
	return { url, origin: new URL(url).origin };
}
export function registerAuthCommands(program: Command, deps: AuthCommandDeps = {}): void {
	const print = deps.print ?? console.log;
	const action = (run: (options: AuthOptions) => Promise<void>) => async (options: AuthOptions) => {
		const resolved = { ...program.opts<AuthOptions>(), ...options };
		try {
			await run(resolved);
		} catch (error) {
			reportAuthError(error, resolved.json);
		}
	};
	const options = (command: Command) =>
		command.option("--url <url>", "Signet instance URL").option("--json", "Machine-readable output");
	options(program.command("login").description("Sign in through the browser device flow"))
		.option("--device-code", "Print the approval URL without opening a browser")
		.option("--non-interactive", "Refuse interactive sign-in")
		.action(
			action(async (opts) => {
				if (opts.nonInteractive || program.opts().nonInteractive)
					throw new Error(
						"Login requires interactive approval. Omit --non-interactive, or provide credentials through the environment.",
					);
				const target = loginTarget(opts, deps);
				const transport = new SignetTransport({ baseUrl: target.url, retries: 0 });
				const device = await transport.post<DeviceStart>("/api/auth/device/start", {
					client: "cli",
					deviceName: hostname(),
					platform: platform(),
				});
				if (
					!device.deviceCode ||
					typeof device.userCode !== "string" ||
					device.userCode.length === 0 ||
					device.userCode.length > 64 ||
					/[^A-Z0-9-]/.test(device.userCode) ||
					!Number.isFinite(device.expiresIn) ||
					device.expiresIn <= 0 ||
					!Number.isFinite(device.interval) ||
					device.interval < 0
				)
					throw new Error("Invalid device authorization response");
				const approval = new URL(device.verificationUriComplete);
				if (
					!["https:", "http:"].includes(approval.protocol) ||
					approval.origin !== target.origin ||
					approval.username ||
					approval.password
				)
					throw new Error("Device approval URL must match the Signet instance origin and contain no credentials");
				const instructions = `Open ${approval.href}\nEnter code: ${device.userCode}`;
				if (opts.json) process.stderr.write(`${instructions}\n`);
				else print(instructions);
				if (!opts.deviceCode) {
					try {
						await (deps.openBrowser ?? open)(approval.href);
					} catch {
						if (opts.json) process.stderr.write("Browser unavailable; open the approval URL above.\n");
						else print("Browser unavailable; open the approval URL above.");
					}
				}
				const deadline = Date.now() + Math.min(device.expiresIn, 600) * 1000;
				let delay = Math.max(device.interval * 1000, 250);
				while (Date.now() < deadline) {
					await new Promise<void>((resolve) => setTimeout(resolve, delay));
					try {
						const token = await transport.post<DeviceToken>(
							"/api/auth/device/token",
							{ deviceCode: device.deviceCode },
							{ timeoutMs: Math.min(10000, Math.max(1, deadline - Date.now())) },
						);
						await new LoginStore(target.origin, deps).save(token);
						await deps.saveUrl?.(target.url);
						const loginOptions = {
							...deps,
							flagUrl: target.url,
							flagKey: undefined,
							harness: undefined,
							env: { ...(deps.env ?? process.env), SIGNET_API_KEY: undefined, SIGNET_API_KEY_FILE: undefined },
						};
						const resolved = await resolveTarget(loginOptions);
						const authenticated = new NodeTransport(resolved, { env: loginOptions.env });
						await authenticated.flush();
						const onboarding = await deps.afterLogin?.({
							target: resolved,
							transport: authenticated,
							options: loginOptions,
							json: opts.json === true,
						});
						print(
							opts.json
								? JSON.stringify({
										authenticated: true,
										url: target.url,
										expiresAt: token.accessExpiresAt,
										...(onboarding === undefined ? {} : { onboarding }),
									})
								: `Signed in to ${target.url}`,
						);
						return;
					} catch (error) {
						if (error instanceof SignetApiError && error.status === 428) continue;
						if (error instanceof SignetApiError && error.status === 429) {
							delay = Math.min(delay + 1000, 10000);
							continue;
						}
						throw error;
					}
				}
				throw new Error("Device authorization expired; run signet login again");
			}),
		);
	options(program.command("logout").description("Revoke the login session"))
		.option("--all", "Revoke all your sessions")
		.action(
			action(async (opts) => {
				const location = loginTarget(opts, deps);
				const store = new LoginStore(location.origin, deps);
				let failure: unknown;
				let revocationConfirmed = false;
				try {
					if (await store.load()) {
						const target = await resolveTarget({ ...deps, flagUrl: location.url });
						await new NodeTransport(target, { env: deps.env }).post("/api/auth/logout", { all: opts.all === true });
						revocationConfirmed = true;
					}
				} catch (error) {
					failure = error;
				} finally {
					await store.clear();
				}
				print(
					opts.json
						? JSON.stringify({ authenticated: false, revocationConfirmed })
						: revocationConfirmed
							? "Signed out"
							: "Signed out locally; server revocation was not confirmed.",
				);
				if (failure !== undefined && !(failure instanceof SignetUnauthorizedError)) reportAuthError(failure, opts.json);
			}),
		);
	options(program.command("whoami").description("Show the authenticated identity")).action(
		action(async (opts) => {
			const target = cliTarget() ?? (await resolveTarget({ ...deps, flagUrl: opts.url ?? deps.flagUrl }));
			const identity = await (cliTransport() ?? new NodeTransport(target, { env: deps.env })).get<{
				mode?: string;
				authenticated?: boolean;
			}>("/api/auth/whoami");
			if (target.remote && identity.mode !== "local" && identity.authenticated !== true)
				throw new SignetUnauthorizedError(target.credential.reason ?? "missing_credential");
			print(
				JSON.stringify(
					{ identity, url: target.url, credentialSource: target.credential.source },
					null,
					opts.json ? undefined : 2,
				),
			);
		}),
	);
	const auth = program.command("auth").description("Manage your devices and sessions");
	options(auth.command("sso").command("set").description("Configure organization SSO without putting a secret in argv"))
		.requiredOption("--issuer <url>", "OIDC issuer")
		.requiredOption("--client-id <id>", "OIDC client ID")
		.option("--client-secret-ref <name>", "Secret-store reference (default: SIGNET_OIDC_CLIENT_SECRET)")
		.option("--client-secret-stdin", "Read the client secret from a bounded stdin pipe")
		.action(
			action(async (opts) => {
				if (opts.clientSecretStdin && opts.clientSecretRef)
					throw new SignetError("Choose a secret reference or stdin, not both", "invalid_request");
				const secret = opts.clientSecretStdin ? await readSecretFromStdin(16384) : undefined;
				const result = await (await authTransport(opts, deps)).post("/api/org/sso", {
					issuer: opts.issuer,
					clientId: opts.clientId,
					...(secret
						? { clientSecret: secret }
						: { clientSecretRef: opts.clientSecretRef ?? "SIGNET_OIDC_CLIENT_SECRET" }),
				});
				print(JSON.stringify(result, null, opts.json ? undefined : 2));
			}),
		);
	for (const kind of ["devices", "sessions"] as const) {
		const group = options(auth.command(kind).description(`List your ${kind}`));
		group.action(
			action(async (opts) => {
				print(
					JSON.stringify(
						await (await authTransport(opts, deps)).get(`/api/auth/${kind}`),
						null,
						opts.json ? undefined : 2,
					),
				);
			}),
		);
		options(group.command("revoke <id>").description(`Revoke a ${kind === "devices" ? "device" : "session"}`)).action(
			async (id: string, opts: AuthOptions) => {
				try {
					print(
						JSON.stringify(
							await (await authTransport(opts, deps)).request("DELETE", `/api/auth/${kind}/${encodeURIComponent(id)}`),
						),
					);
				} catch (error) {
					reportAuthError(error, opts.json ?? program.opts<AuthOptions>().json);
				}
			},
		);
		if (kind === "devices") {
			options(group.command("rename <id> <name>")).action(async (id: string, name: string, opts: AuthOptions) => {
				try {
					print(
						JSON.stringify(
							await (await authTransport(opts, deps)).request("PATCH", `/api/auth/devices/${encodeURIComponent(id)}`, {
								body: { name },
							}),
						),
					);
				} catch (error) {
					reportAuthError(error, opts.json ?? program.opts<AuthOptions>().json);
				}
			});
		}
	}
}
