import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/shell/panel";
import { Badge } from "@/components/ui/badge";
import { type ApiReadResult, getJSONResult } from "@/lib/api";
import { usePanelQuery } from "@/lib/use-panel-query";
import {
	type UpgradeInventory,
	type UpgradeJob,
	upgradeDeadline,
	upgradeDeadlineInput,
} from "@/lib/organization-upgrade";
import { Action, Choice, Message, OrganizationBlock, TextField } from "./controls";

export function OrganizationUpgrade({ onUpdated }: { readonly onUpdated: () => void }) {
	const { result, refresh } = usePanelQuery<UpgradeInventory>("/api/org/upgrade");
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<UpgradeJob | undefined>();
	return (
		<OrganizationBlock
			title="Upgrade a team-mode workspace"
			description="Review existing agent ownership, unowned keys, and the legacy-key deadline. Nothing changes before confirmation."
		>
			<Panel result={result} onRetry={refresh}>
				{(inventory) =>
					open ? (
						<UpgradeWizard
							key={selected?.id ?? "new"}
							inventory={inventory}
							initialJob={selected}
							onClose={() => {
								setOpen(false);
								refresh();
								onUpdated();
							}}
						/>
					) : (
						<div className="flex flex-col gap-3 text-small">
							<p>
								{inventory.agents.length} legacy agents · {inventory.keys.length} unowned keys
							</p>
							{inventory.legacyKeyDeadline && (
								<p>Unassigned keys stop working after {new Date(inventory.legacyKeyDeadline).toLocaleString()}.</p>
							)}
							<Action
								onClick={() => {
									setSelected(undefined);
									setOpen(true);
								}}
							>
								Review upgrade
							</Action>
							{inventory.jobs.map((job) => (
								<div key={job.id} className="flex flex-wrap items-center gap-3">
									<Badge>{job.status}</Badge>
									<Action
										secondary
										onClick={() => {
											setSelected(job);
											setOpen(true);
										}}
									>
										Open {job.phase === "draft" ? "draft" : "upgrade job"}
									</Action>
								</div>
							))}
						</div>
					)
				}
			</Panel>
		</OrganizationBlock>
	);
}

export function UpgradeWizard({
	inventory,
	initialJob,
	onClose,
}: {
	readonly inventory: UpgradeInventory;
	readonly initialJob?: UpgradeJob;
	readonly onClose: () => void;
}) {
	const [step, setStep] = useState(initialJob?.phase === "draft" ? 3 : 0);
	const [job, setJob] = useState(initialJob ?? null);
	const [mappings, setMappings] = useState<Readonly<Record<string, string>>>(() =>
		Object.fromEntries(
			initialJob?.preview.agents.map((agent) => [
				agent.agentId,
				agent.kind === "personal"
					? `user:${agent.ownerUserId}`
					: agent.kind === "team"
						? `team:${agent.ownerGroupId}`
						: "organization",
			]) ?? [],
		),
	);
	const [keys, setKeys] = useState<Readonly<Record<string, string>>>(() =>
		Object.fromEntries(
			initialJob?.preview.keys.map((key) => [
				key.id,
				key.action === "assign" ? `user:${key.userId}` : key.action === "revoke" ? "revoke" : "later",
			]) ?? [],
		),
	);
	const [deadline, setDeadline] = useState(() =>
		upgradeDeadlineInput(initialJob?.preview.legacyKeyDeadline ?? inventory.legacyKeyDeadline),
	);
	const [reviewed, setReviewed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [poll, setPoll] = useState<ApiReadResult<UpgradeJob> | null>(null);
	const [retry, setRetry] = useState(0);
	const request = useRef<AbortController | null>(null);
	useEffect(() => () => request.current?.abort(), []);
	useEffect(() => {
		if (job?.status !== "running") return;
		const abort = new AbortController();
		let pending = false;
		let forbidden = false;
		const read = async () => {
			if (pending || forbidden) return;
			pending = true;
			const result = await getJSONResult<UpgradeJob>(`/api/org/upgrade/${encodeURIComponent(job.id)}`, {
				signal: abort.signal,
			});
			pending = false;
			if (abort.signal.aborted) return;
			setPoll(result);
			if (result.data) setJob(result.data);
			if (result.status === 401 || result.status === 403) forbidden = true;
		};
		void read();
		const timer = setInterval(() => void read(), 500);
		return () => {
			abort.abort();
			clearInterval(timer);
		};
	}, [job?.id, job?.status, retry]);
	const send = async (path: string, method: string, body: unknown) => {
		if (busy) return;
		const abort = new AbortController();
		request.current = abort;
		setBusy(true);
		setError(null);
		const result = await getJSONResult<UpgradeJob>(path, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: abort.signal,
		});
		if (abort.signal.aborted) return;
		setBusy(false);
		if (result.data) {
			setJob(result.data);
			setStep(3);
			setReviewed(false);
			if (result.data.status === "running") setRetry((value) => value + 1);
		} else setError(result.error ?? "The operation was not accepted. No completion is being reported.");
	};
	const preview = async () => {
		const date = upgradeDeadline(deadline);
		if (!date) {
			setError("Enter a valid legacy-key deadline.");
			return;
		}
		const agents = inventory.agents.flatMap<{
			agentId: string;
			kind: "personal" | "team";
			ownerUserId?: string;
			ownerGroupId?: string;
		}>((agent) => {
			const target = mappings[agent.id] ?? "organization";
			if (target.startsWith("user:"))
				return [{ agentId: agent.id, kind: "personal", ownerUserId: target.slice(5), ownerGroupId: undefined }];
			if (target.startsWith("team:"))
				return [{ agentId: agent.id, kind: "team", ownerGroupId: target.slice(5), ownerUserId: undefined }];
			return [];
		});
		const actions = inventory.keys.flatMap<{ id: string; action: "assign" | "revoke"; userId?: string }>((key) => {
			const target = keys[key.id] ?? "later";
			if (target.startsWith("user:")) return [{ id: key.id, action: "assign", userId: target.slice(5) }];
			if (target === "revoke") return [{ id: key.id, action: "revoke", userId: undefined }];
			return [];
		});
		const plan = { mappings: agents, keys: actions, legacyKeyDeadline: date };
		if (job?.phase === "draft")
			await send(`/api/org/upgrade/${encodeURIComponent(job.id)}`, "PUT", { revision: job.revision, plan });
		else await send("/api/org/upgrade/preview", "POST", plan);
	};
	const control = (action: "confirm" | "cancel" | "resume") => {
		if (!job || (action === "confirm" && !reviewed)) return;
		void send(`/api/org/upgrade/${encodeURIComponent(job.id)}/${action}`, "POST", { revision: job.revision });
	};
	const applied = job && job.phase !== "draft";
	return (
		<div className="flex min-w-0 flex-col gap-6 text-small">
			{applied ? (
				<OrganizationBlock
					title={
						job.phase === "complete"
							? "Upgrade complete"
							: job.phase === "cancelled"
								? "Draft cancelled"
								: "Upgrade job"
					}
				>
					<Badge>{job.status}</Badge>
					<p>
						{job.completedSteps} of {job.totalSteps} ownership, key, and deadline steps are durably complete. These are
						configuration steps, not memory counts.
					</p>
					{job.status === "running" && (
						<p role="status">
							Accepted and running. Closing this screen does not cancel the job. The daemon resumes committed progress
							after a restart.
						</p>
					)}
					{job.error && (
						<p role="alert">
							Upgrade stopped: {job.error}. Completed steps are retained. Resolve the conflict, then resume the same
							reviewed plan.
						</p>
					)}
					{job.phase === "applying" && (
						<Action secondary disabled={busy} onClick={() => control("resume")}>
							Retry continuation
						</Action>
					)}
					{poll?.error && (
						<Panel result={poll} onRetry={() => setRetry((value) => value + 1)}>
							{() => null}
						</Panel>
					)}
				</OrganizationBlock>
			) : step === 0 ? (
				<OrganizationBlock
					title="Map existing agents"
					description="Map each existing agent to a person, a team, or organization memory. Unmapped agents fall back to the organization."
				>
					{inventory.agents.map((agent) => (
						<div className="rounded-lg border p-4" key={agent.id}>
							<Choice
								label={agent.name}
								value={mappings[agent.id] ?? "organization"}
								onChange={(value) => setMappings((previous) => ({ ...previous, [agent.id]: value }))}
								options={[
									{ value: "organization", label: "Organization memory — default fallback" },
									...inventory.users.map((user) => ({ value: `user:${user.id}`, label: `Person: ${user.name}` })),
									...inventory.groups.map((group) => ({ value: `team:${group.id}`, label: `Team: ${group.name}` })),
								]}
							/>
						</div>
					))}
					{inventory.agents.length === 0 && (
						<p>No legacy agents need mapping. You can still manage unowned keys and the deadline.</p>
					)}
					<p>
						Original agent IDs, evidence, authorship, classifications, and citations are retained. This does not invent
						author users or replace your users' existing default personal agents.
					</p>
					<Action onClick={() => setStep(1)}>Continue</Action>
				</OrganizationBlock>
			) : step === 1 ? (
				<OrganizationBlock
					title="Unowned API keys"
					description="Assign each existing key to a person, revoke it, or leave it unassigned until the explicit deadline."
				>
					{inventory.keys.map((key) => (
						<div className="flex flex-col gap-3 rounded-lg border p-4" key={key.id}>
							<p>
								{key.name} · <code>{key.prefix}</code>
							</p>
							<Choice
								label={`Owner for ${key.name}`}
								value={keys[key.id] ?? "later"}
								onChange={(value) => setKeys((previous) => ({ ...previous, [key.id]: value }))}
								options={[
									{ value: "later", label: "Assign later — deadline applies" },
									{ value: "revoke", label: "Revoke on confirmation" },
									...inventory.users.map((user) => ({ value: `user:${user.id}`, label: user.name })),
								]}
							/>
						</div>
					))}
					{inventory.keys.length === 0 && <p>No unowned legacy keys remain.</p>}
					<p>
						Assigned keys retain their existing permissions and bindings, bounded by the assigned user's access.
						Revocation takes effect on the next request.
					</p>
					<Action secondary onClick={() => setStep(0)}>
						Back
					</Action>
					<Action onClick={() => setStep(2)}>Continue</Action>
				</OrganizationBlock>
			) : step === 2 ? (
				<OrganizationBlock
					title="Legacy key deadline"
					description="After this exact deadline, the daemon rejects every remaining unassigned legacy key."
				>
					<TextField label="Legacy key deadline" type="datetime-local" value={deadline} onChange={setDeadline} />
					{upgradeDeadline(deadline) && new Date(deadline).getTime() <= Date.now() && (
						<p role="alert" className="text-destructive">
							This deadline has passed. Remaining unassigned keys will be rejected immediately when the upgrade
							completes.
						</p>
					)}
					<p>
						Assigning or revoking keys is explicit. The bootstrap administrator password is not disabled by this
						upgrade.
					</p>
					<Action secondary onClick={() => setStep(1)}>
						Back
					</Action>
					<Action disabled={busy || !upgradeDeadline(deadline)} onClick={() => void preview()}>
						Review dry run
					</Action>
				</OrganizationBlock>
			) : job ? (
				<OrganizationBlock
					title="Review upgrade"
					description="This is the daemon's saved dry run. You can change any mapping or cancel before confirmation. Confirmation applies this exact revision."
				>
					{job.preview.agents.map((agent) => (
						<p key={agent.agentId}>
							<strong>{agent.name}</strong> →{" "}
							{agent.kind === "personal"
								? (inventory.users.find((user) => user.id === agent.ownerUserId)?.name ?? "Person unavailable")
								: agent.kind === "team"
									? (inventory.groups.find((group) => group.id === agent.ownerGroupId)?.name ?? "Team unavailable")
									: "Organization memory"}{" "}
							{agent.fallback && <Badge>Unmapped — organization fallback</Badge>}
						</p>
					))}
					{job.preview.keys.map((key) => (
						<p key={key.id}>
							{key.name} · <code>{key.prefix}</code> →{" "}
							{key.action === "assign"
								? (inventory.users.find((user) => user.id === key.userId)?.name ?? "Person unavailable")
								: key.action === "revoke"
									? "Revoke"
									: "Keep unassigned until deadline"}
						</p>
					))}
					<p>
						Legacy key deadline: <strong>{new Date(job.preview.legacyKeyDeadline).toLocaleString()}</strong>
					</p>
					<p>{job.preview.retainedStorePolicy}</p>
					<label className="flex items-start gap-3">
						<input
							className="mt-1"
							type="checkbox"
							checked={reviewed}
							onChange={(event) => setReviewed(event.target.checked)}
						/>
						I reviewed the exact mappings, key actions, and deadline.
					</label>
					<Action
						secondary
						disabled={busy}
						onClick={() => {
							setReviewed(false);
							setStep(0);
						}}
					>
						Back to edit
					</Action>
					<Action secondary disabled={busy} onClick={() => control("cancel")}>
						Cancel draft
					</Action>
					<Action disabled={busy || !reviewed} onClick={() => control("confirm")}>
						Confirm upgrade
					</Action>
				</OrganizationBlock>
			) : null}
			<Message error={error} />
			<Action secondary onClick={onClose}>
				Close upgrade
			</Action>
		</div>
	);
}
