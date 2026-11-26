import { useState } from "react";
import { usePanelQuery } from "@/lib/use-panel-query";
import { displayLabel } from "./controls";
import { dashboardFetch, getJSONResult } from "@/lib/api";
import type { OrganizationAgent, OrganizationKey } from "@/lib/organization";
import {
	Action,
	DateValue,
	Message,
	OrganizationBlock,
	OrganizationTable,
	TextField,
	cellClass,
	rowClass,
} from "./controls";
import { TrackedJob } from "./job";
import { SharedKeyForm } from "./teams";

export function KeysContent({
	keys,
	agents,
	permissions,
}: {
	keys: readonly OrganizationKey[];
	agents: readonly OrganizationAgent[];
	permissions: readonly string[];
}) {
	const people = usePanelQuery<{ users: readonly { id: string; display_name: string }[] }>("/api/org/users");
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const revoke = async () => {
		if (!window.confirm(`Revoke ${selected.length} selected keys? This cannot be undone.`)) return;
		setBusy(true);
		const result = await getJSONResult<{ jobId: string }>("/api/org/keys/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids: selected }),
		});
		setBusy(false);
		setError(result.error);
		setJobId(result.data?.jobId ?? null);
		if (result.data) setSelected([]);
	};
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock title="All API keys">
				<OrganizationTable columns={["Select", "Key", "User / device", "Harness / agent", "Last used", "Expiry"]}>
					{keys.map((key) => (
						<tr key={key.id} className={rowClass}>
							<td className={cellClass}>
								<input
									type="checkbox"
									aria-label={`Select ${key.name}`}
									disabled={Boolean(key.revoked_at)}
									checked={selected.includes(key.id)}
									onChange={(event) =>
										setSelected(event.target.checked ? [...selected, key.id] : selected.filter((id) => id !== key.id))
									}
								/>
							</td>
							<td className={cellClass}>
								{key.name}
								<div className="font-mono text-xs text-muted-foreground">{key.prefix}</div>
								{key.revoked_at && <span>Revoked</span>}
							</td>
							<td className={cellClass}>
								{people.result?.data?.users.find((person) => person.id === key.user_id)?.display_name ??
									(key.user_id ? "Person" : "Unassigned")}
								<div className="break-all text-xs text-muted-foreground">{key.user_id}</div>
								<div className="text-muted-foreground">{key.device_id ?? "No device"}</div>
							</td>
							<td className={cellClass}>
								{key.harness ? displayLabel(key.harness) : "Script"}
								<div className="text-muted-foreground">
									{agents.find((agent) => agent.id === key.agent_id)?.name ?? (key.agent_id ? "Agent" : "No agent")}
								</div>
							</td>
							<td className={cellClass}>
								<DateValue value={key.last_used_at} />
							</td>
							<td className={cellClass}>
								<DateValue value={key.expires_at} />
							</td>
						</tr>
					))}
				</OrganizationTable>
				<Action disabled={busy || selected.length === 0} onClick={() => void revoke()}>
					Revoke selected keys
				</Action>
				<Message error={error} />
				{jobId && <TrackedJob id={jobId} />}
			</OrganizationBlock>
			<SharedKeyForm
				agents={agents.filter((agent) => agent.kind === "team" && !agent.archivedAt)}
				permissions={permissions}
			/>
		</div>
	);
}
export interface AuditEvent {
	readonly id: string;
	readonly at: string;
	readonly actor_user_id: string | null;
	readonly action: string;
	readonly target_kind: string | null;
	readonly target_id: string | null;
	readonly outcome: string;
}
export interface AuditPage {
	readonly events: readonly AuditEvent[];
	readonly nextCursor: string | null;
}
export function AuditContent({
	page,
	query,
	onNext,
	retention,
	admin,
	refresh,
}: {
	page: AuditPage;
	query: string;
	onNext: (cursor: string) => void;
	retention: number | null;
	admin: boolean;
	refresh: () => void;
}) {
	const [days, setDays] = useState(String(retention ?? 365));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const exportAudit = async () => {
		setBusy(true);
		setError(null);
		try {
			const response = await dashboardFetch(`/api/org/audit/export?${query}`, {
				headers: { Accept: "application/x-ndjson" },
			});
			if (!response.ok) {
				setError(`Audit export failed (${response.status}).`);
				return;
			}
			const blob = await response.blob();
			if (blob.size > 64 * 1024 * 1024) {
				setError("Audit export exceeded 64 MiB. Narrow the time range.");
				return;
			}
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "signet-audit.ndjson";
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			setError("Audit export unavailable. Retry or narrow the time range.");
		} finally {
			setBusy(false);
		}
	};
	const saveRetention = async () => {
		setBusy(true);
		const result = await getJSONResult("/api/org/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ auditRetentionDays: Number(days) }),
		});
		setBusy(false);
		setError(result.error);
		if (result.data) refresh();
	};
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock
				title="Audit events"
				description="Credential events, classification changes and organization operations. Exports follow the selected filters."
			>
				<OrganizationTable columns={["Time", "Actor", "Action", "Target", "Outcome"]}>
					{page.events.map((event) => (
						<tr key={event.id} className={rowClass}>
							<td className={cellClass}>
								<DateValue value={event.at} />
							</td>
							<td className={cellClass}>
								{event.actor_user_id ? "Person" : "System"}
								<div className="break-all text-xs text-muted-foreground">{event.actor_user_id}</div>
							</td>
							<td className={cellClass}>{event.action}</td>
							<td className={`${cellClass} break-all`}>
								{event.target_kind ? displayLabel(event.target_kind) : "Instance"}
								<div className="text-xs text-muted-foreground">{event.target_id}</div>
							</td>
							<td className={cellClass}>{displayLabel(event.outcome)}</td>
						</tr>
					))}
				</OrganizationTable>
				<div className="flex gap-2">
					<Action secondary disabled={busy} onClick={() => void exportAudit()}>
						Export NDJSON
					</Action>
					{page.nextCursor && (
						<Action secondary onClick={() => onNext(page.nextCursor ?? "")}>
							Next page
						</Action>
					)}
				</div>
			</OrganizationBlock>
			{admin && (
				<OrganizationBlock
					title="Audit retention"
					description="Retention is enforced by the daemon. Changing this setting does not claim that cleanup has already completed."
				>
					<TextField label="Retention days" type="number" value={days} onChange={setDays} />
					<Action disabled={busy || Number(days) < 1 || Number(days) > 3650} onClick={() => void saveRetention()}>
						Save retention
					</Action>
				</OrganizationBlock>
			)}
			<Message error={error} />
		</div>
	);
}
export function HealthContent({ status }: { status: Record<string, unknown> }) {
	const auth = typeof status.auth === "object" && status.auth !== null ? status.auth : {};
	const proxy = Reflect.get(auth, "hybridProxyDetected") === true;
	return (
		<OrganizationBlock
			title="Instance health"
			description="Daemon-reported status. Missing capacity metrics are unavailable, not healthy."
		>
			{proxy && (
				<p role="alert" className="text-small text-destructive">
					Hybrid mode detected behind a proxy. Loopback trust is disabled for forwarded requests.
				</p>
			)}
			<dl className="grid grid-cols-2 gap-3 text-small">
				<dt className="text-muted-foreground">Connection</dt>
				<dd>Connected</dd>
				<dt className="text-muted-foreground">Version</dt>
				<dd>{typeof status.version === "string" ? status.version : "Unavailable"}</dd>
				<dt className="text-muted-foreground">Capacity</dt>
				<dd>Unavailable</dd>
			</dl>
		</OrganizationBlock>
	);
}
