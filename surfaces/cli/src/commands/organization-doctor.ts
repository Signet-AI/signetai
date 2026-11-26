import { attemptAsync } from "@signet/core";
import {
	ConnectorRegistry,
	NodeTransport,
	readKeyFile,
	resolveTarget,
	type ResolveTargetOptions,
} from "../../../../libs/sdk/src/node.js";
import {
	SignetApiError,
	SignetError,
	SignetForbiddenError,
	SignetUnauthorizedError,
} from "../../../../libs/sdk/src/index.js";
import { connectorFor, supportedHarnesses } from "./connector.js";
import { inspectConnectorFiles } from "../lib/connector-doctor.js";

interface Finding {
	readonly reason: string;
	readonly message: string;
	readonly fix?: string;
}
interface Report {
	readonly serverTime: string;
	readonly status: string;
	readonly identity: {
		readonly authenticated: boolean;
		readonly organization: { readonly name: string };
		readonly user: { readonly username: string };
		readonly credential: { readonly kind?: string; readonly expiresAt: string | null } | null;
	};
	readonly diagnostics: { readonly database: string; readonly content: string };
}
export async function organizationDoctor(
	transport: NodeTransport,
	url: string,
	json = false,
	deps: ResolveTargetOptions = {},
) {
	const began = Date.now();
	const report = await transport.get<Report>("/api/org/operator/doctor");
	const ended = Date.now(),
		findings: Finding[] = [];
	const instant = Date.parse(report.serverTime),
		clockSkewMs = Number.isFinite(instant) ? instant - (began + ended) / 2 : null;
	if (clockSkewMs === null)
		findings.push({ reason: "clock_unavailable", message: "The instance did not supply a valid server clock." });
	else if (Math.abs(clockSkewMs) > 30_000)
		findings.push({
			reason: "clock_skew",
			message: "Local and instance clocks differ by more than 30 seconds.",
			fix: "Synchronize both machines' system clocks before relying on token expiry.",
		});
	if (report.diagnostics.database !== "ready")
		findings.push({ reason: "instance_degraded", message: "The instance database owner is unavailable." });
	const expiry = report.identity.credential?.expiresAt;
	if (
		expiry &&
		Date.parse(expiry) - Date.now() < (report.identity.credential?.kind === "session" ? 60_000 : 3 * 86400_000)
	)
		findings.push({
			reason: "credential_expiring",
			message: "Your credential is nearing expiry.",
			fix: "Run signet login to renew your session.",
		});
	const deadline = Date.now() + 20_000,
		inlineKeys = [];
	for (const harness of supportedHarnesses) {
		if (Date.now() >= deadline) {
			findings.push({ reason: "scan_incomplete", message: "Local harness inspection reached its deadline." });
			break;
		}
		const result = await inspectConnectorFiles(connectorFor(harness).getConfigPaths());
		if (result.inlineKeyFiles.length || result.scanIncomplete) {
			inlineKeys.push({
				harness,
				...result,
				fix: `Run signet connect ${harness} to replace inline keys with protected key files.`,
			});
			findings.push({
				reason: result.inlineKeyFiles.length ? "inline_key" : "scan_incomplete",
				message: `Inspect ${harness}'s Signet configuration.`,
				fix: `Run signet connect ${harness}.`,
			});
		}
	}
	const connectors: Record<string, unknown>[] = [];
	for (const [harness, entry] of Object.entries(await new ConnectorRegistry(deps).read())) {
		if (new URL(entry.url).origin !== new URL(url).origin) continue;
		if (Date.now() >= deadline) {
			findings.push({ reason: "connector_checks_incomplete", message: "Connector checks reached their deadline." });
			break;
		}
		let keyFile = "missing",
			status: number | null = null,
			reason: string | null = null;
		try {
			if (!entry.keyFile) throw new SignetError("Connector has no protected key file", "missing_key_file");
			keyFile = "invalid";
			const key = await readKeyFile(entry.keyFile);
			keyFile = "protected";
			const target = await resolveTarget({ ...deps, flagUrl: entry.url, flagKey: key });
			const probe = new NodeTransport(target, {
				env: deps.env,
				retries: 0,
				timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())),
			});
			const identity = await probe.get<{ authenticated: boolean; credential?: { id?: string } }>("/api/auth/whoami");
			if (!identity.authenticated || (entry.keyId && identity.credential?.id !== entry.keyId))
				throw new SignetError("Connector identity does not match its registry entry", "binding_mismatch");
			status = 200;
		} catch (error) {
			status = error instanceof SignetApiError ? error.status : null;
			reason =
				error instanceof SignetUnauthorizedError || error instanceof SignetForbiddenError
					? error.reason
					: error instanceof SignetError
						? error.code
						: "connector_unavailable";
			findings.push({
				reason: reason ?? "connector_unavailable",
				message: `${harness} could not authenticate with this instance.`,
				fix: `Run signet connect ${harness}.`,
			});
		}
		const keyId = entry.keyId;
		const history = keyId
			? await attemptAsync(() =>
					transport.get<{ errors: readonly { at: string; status: number; reason: string }[] }>(
						`/api/auth/connector-keys/${encodeURIComponent(keyId)}/errors`,
						{ timeoutMs: Math.max(1, Math.min(3000, deadline - Date.now())) },
					),
				)
			: undefined;
		connectors.push({
			harness,
			keyFile,
			status,
			reason,
			errors: history?.errors ?? null,
			historyStatus: history ? "available" : "unavailable",
		});
	}
	const result = {
		...report,
		clock: { skewMs: clockSkewMs, roundTripMs: ended - began },
		connectors,
		inlineKeys,
		findings,
		ok: findings.length === 0,
	};
	if (findings.length) process.exitCode = 2;
	if (!json) console.log(`${report.identity.organization.name} · ${report.identity.user.username} · ${report.status}`);
	console.log(JSON.stringify(result, null, json ? undefined : 2));
}
