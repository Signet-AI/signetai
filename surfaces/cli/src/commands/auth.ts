import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { hostname, platform } from "node:os";
import type { Command } from "commander";
import open from "open";
import {
	SignetApiError,
	SignetError,
	SignetForbiddenError,
	SignetTransport,
	SignetUnauthorizedError,
} from "../../../../libs/sdk/src/index.js";
import { LoginStore, NodeTransport, resolveTarget, type ResolveTargetOptions } from "../../../../libs/sdk/src/node.js";

export interface AuthCommandDeps extends ResolveTargetOptions {
	readonly print?: (value: string) => void;
	readonly openBrowser?: (url: string) => Promise<unknown>;
	readonly saveUrl?: (url: string) => Promise<void>;
}
interface AuthOptions {
	url?: string;
	json?: boolean;
	all?: boolean;
	deviceCode?: boolean;
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
				: "request_failed";
	const message =
		status === 401 ? unauthorizedMessage : error instanceof Error ? error.message : "Signet request failed";
	process.stderr.write(`${json ? JSON.stringify({ error: message, reason, status }) : message}\n`);
	process.exitCode = status === 401 ? 3 : status === 403 ? 4 : 1;
}
export async function authTransport(options: AuthOptions, deps: AuthCommandDeps = {}): Promise<NodeTransport> {
	return new NodeTransport(await resolveTarget({ ...deps, flagUrl: options.url ?? deps.flagUrl }), { env: deps.env });
}
function loginTarget(options: AuthOptions, deps: AuthCommandDeps): { url: string; origin: string } {
	const env = deps.env ?? process.env;
	const url = resolveSignetDaemonUrl({
		env: { ...env, SIGNET_DAEMON_URL: options.url ?? deps.flagUrl ?? env.SIGNET_DAEMON_URL },
		configUrl: deps.configUrl,
	});
	return { url, origin: new URL(url).origin };
}
export function registerAuthCommands(program: Command, deps: AuthCommandDeps = {}): void {
	const print = deps.print ?? console.log;
	const action = (run: (options: AuthOptions) => Promise<void>) => async (options: AuthOptions) => {
		try {
			await run(options);
		} catch (error) {
			reportAuthError(error, options.json);
		}
	};
	const options = (command: Command) =>
		command.option("--url <url>", "Signet instance URL").option("--json", "Machine-readable output");
	options(program.command("login").description("Sign in through the browser device flow"))
		.option("--device-code", "Print the approval URL without opening a browser")
		.action(
			action(async (opts) => {
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
				print(`Open ${approval.href}\nEnter code: ${device.userCode}`);
				if (!opts.deviceCode) {
					try {
						await (deps.openBrowser ?? open)(approval.href);
					} catch {
						print("Browser unavailable; open the approval URL above.");
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
						const authenticated = await authTransport({ url: target.url }, deps);
						await authenticated.flush();
						print(
							opts.json
								? JSON.stringify({ authenticated: true, url: target.url, expiresAt: token.accessExpiresAt })
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
			const target = await resolveTarget({ ...deps, flagUrl: opts.url ?? deps.flagUrl });
			const identity = await new NodeTransport(target, { env: deps.env }).get<unknown>("/api/auth/whoami");
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
					reportAuthError(error, opts.json);
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
					reportAuthError(error, opts.json);
				}
			});
		}
	}
}
