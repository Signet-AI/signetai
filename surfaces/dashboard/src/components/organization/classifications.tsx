import { useWhoami } from "@/lib/session";
import { useState, useCallback } from "react";
import { ClassificationBadges } from "@/components/shell/attribution";
import { Panel } from "@/components/shell/panel";
import { usePanelQuery } from "@/lib/use-panel-query";
import { getJSONResult } from "@/lib/api";
import type { ClassificationPrincipal, ClassificationTarget, OrganizationClassification } from "@/lib/organization";
import {
	Action,
	Choice,
	Message,
	OrganizationBlock,
	OrganizationTable,
	TextField,
	cellClass,
	rowClass,
} from "./controls";
import { EvidenceList } from "./evidence-list";
import { displayLabel } from "./controls";
import { TrackedJob } from "./job";

export function ClassifyAction({ target }: { target: ClassificationTarget }) {
	const [open, setOpen] = useState(false);
	const whoami = useWhoami();
	if (!whoami) return null;
	return open ? (
		<ClassifyForm
			key={`${target.kind}:${target.agentId}:${target.id}`}
			target={target}
			onClose={() => setOpen(false)}
		/>
	) : (
		<Action secondary onClick={() => setOpen(true)}>
			Classify…
		</Action>
	);
}
function ClassifyForm({ target, onClose }: { target: ClassificationTarget; onClose: () => void }) {
	const whoami = useWhoami();
	const [completed, setCompleted] = useState(false);
	const finished = useCallback(() => setCompleted(true), []);
	const classifications = usePanelQuery<readonly OrganizationClassification[]>("/api/classifications");
	const [classificationId, setClassificationId] = useState("");
	const [preview, setPreview] = useState<{ evidence: number; derived: number } | null>(null);
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const execute = async (apply: boolean) => {
		setBusy(true);
		setError(null);
		const path = `/api/classifications/${encodeURIComponent(classificationId)}/${apply ? "apply" : "preview"}`;
		if (apply) {
			const result = await getJSONResult<{ jobId: string }>(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target }),
			});
			setError(result.error);
			setJobId(result.data?.jobId ?? null);
		} else {
			const result = await getJSONResult<{ evidence: number; derived: number }>(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ target }),
			});
			setError(result.error);
			setPreview(result.data);
		}
		setBusy(false);
	};
	return (
		<OrganizationBlock
			title={`Classify ${target.kind}`}
			description="Classification changes include evidence and the derived state that cites it. Only the audience can read classified material."
		>
			{jobId ? (
				<>
					<TrackedJob id={jobId} onComplete={finished} />
					{completed && whoami && (
						<ClassificationBadges
							classifications={(classifications.result?.data ?? []).filter(
								(definition) => definition.id === classificationId,
							)}
							audienceIds={
								new Set(
									(classifications.result?.data ?? [])
										.filter(
											(definition) =>
												!whoami.user.compliance ||
												definition.audience?.some((principal) =>
													principal.kind === "user"
														? principal.id === whoami.user.id
														: whoami.user.groups.some((group) => group.id === principal.id),
												),
										)
										.map((definition) => definition.id),
								)
							}
						/>
					)}
				</>
			) : (
				<>
					<Panel
						result={classifications.result}
						empty={classifications.result?.data?.length === 0}
						emptyMessage="No classifications available."
						onRetry={classifications.refresh}
					>
						{(definitions) => (
							<Choice
								label="Classification"
								value={classificationId}
								onChange={(value) => {
									setClassificationId(value);
									setPreview(null);
								}}
								options={[
									{ value: "", label: "Select a classification" },
									...definitions
										.filter((item) => !item.archived_at)
										.map((item) => ({ value: item.id, label: item.name })),
								]}
							/>
						)}
					</Panel>
					<Action disabled={busy || !classificationId} onClick={() => void execute(false)}>
						Preview impact
					</Action>
					{preview && (
						<>
							<p role="status" className="text-small">
								This will reclassify {preview.evidence} readable evidence rows and {preview.derived} derived claims and
								supporting rows.
							</p>
							<Action disabled={busy} onClick={() => void execute(true)}>
								Apply classification
							</Action>
						</>
					)}
				</>
			)}
			<Message error={error} />
			<Action secondary onClick={onClose}>
				Close classification
			</Action>
		</OrganizationBlock>
	);
}

export function PrincipalEditor({
	title,
	values,
	onChange,
}: {
	title: string;
	values: readonly ClassificationPrincipal[];
	onChange: (values: readonly ClassificationPrincipal[]) => void;
}) {
	const whoami = useWhoami();
	const [kind, setKind] = useState("group");
	const [id, setId] = useState("");
	const groups = usePanelQuery<{ groups: readonly { id: string; name: string }[] }>("/api/org/groups");
	const users = usePanelQuery<{ users: readonly { id: string; display_name: string }[] }>(
		whoami?.user.role === "admin" ? "/api/org/users" : null,
	);
	const options =
		kind === "group"
			? (groups.result?.data?.groups ?? []).map((group) => ({ value: group.id, label: group.name }))
			: (
					users.result?.data?.users ?? (whoami ? [{ id: whoami.user.id, display_name: whoami.user.displayName }] : [])
				).map((user) => ({ value: user.id, label: user.display_name }));
	return (
		<OrganizationBlock title={title}>
			<Choice
				label={`${title} kind`}
				value={kind}
				onChange={(value) => {
					setKind(value);
					setId("");
				}}
				options={[
					{ value: "group", label: "Team" },
					{ value: "user", label: "Person" },
				]}
			/>
			<Choice
				label={`Add to ${title.toLowerCase()}`}
				value={id}
				onChange={setId}
				options={[{ value: "", label: "Choose a person or team" }, ...options]}
			/>
			<Action
				secondary
				disabled={!id}
				onClick={() => {
					const value: ClassificationPrincipal = {
						kind: kind === "group" ? "group" : "user",
						id,
						displayName: options.find((option) => option.value === id)?.label,
					};
					if (!values.some((item) => item.kind === value.kind && item.id === id)) onChange([...values, value]);
					setId("");
				}}
			>
				Add {title.toLowerCase()}
			</Action>
			{values.map((value) => (
				<div className="settings-row" key={`${value.kind}:${value.id}`}>
					<span className="text-small" title={value.id}>
						{value.displayName ??
							options.find((option) => option.value === value.id)?.label ??
							displayLabel(value.kind)}
					</span>
					<Action secondary onClick={() => onChange(values.filter((item) => item !== value))}>
						Remove
					</Action>
				</div>
			))}
		</OrganizationBlock>
	);
}
interface ClassificationItemPage {
	readonly items: readonly {
		target_kind: string;
		target_id: string;
		agent_id: string;
		memory?: { id: string; content: string } | null;
	}[];
	readonly nextCursor: string | null;
}
function ClassificationItems({ classification }: { classification: OrganizationClassification }) {
	const [cursor, setCursor] = useState("");
	const [history, setHistory] = useState<readonly string[]>([]);
	const page = usePanelQuery<ClassificationItemPage>(
		`/api/classifications/${encodeURIComponent(classification.id)}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
	);
	return (
		<OrganizationBlock title={`${classification.name} items`}>
			<Panel
				result={page.result}
				empty={page.result?.data?.items.length === 0}
				emptyMessage="No readable items carry this classification."
				onRetry={page.refresh}
			>
				{(data) => (
					<EvidenceList
						rows={data.items.map((item) => ({
							key: `${item.target_kind}:${item.agent_id}:${item.target_id}`,
							title: item.memory?.content.slice(0, 180) ?? `${displayLabel(item.target_kind)} material`,
							identifier: item.target_id,
							kind: item.target_kind,
							agent: "Agent",
						}))}
					/>
				)}
			</Panel>
			<div className="flex gap-2">
				<Action
					secondary
					disabled={!history.length}
					onClick={() => {
						setCursor(history.at(-1) ?? "");
						setHistory(history.slice(0, -1));
					}}
				>
					Previous page
				</Action>
				<Action
					secondary
					disabled={!page.result?.data?.nextCursor}
					onClick={() => {
						const next = page.result?.data?.nextCursor;
						if (next) {
							setHistory([...history, cursor]);
							setCursor(next);
						}
					}}
				>
					Next page
				</Action>
			</div>
		</OrganizationBlock>
	);
}
export function ClassificationsContent({
	classifications,
	canManage,
	refresh,
}: {
	classifications: readonly OrganizationClassification[];
	canManage: boolean;
	refresh: () => void;
}) {
	const [selected, setSelected] = useState<OrganizationClassification | null>(null);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState("");
	const [description, setDescription] = useState("");
	const [audience, setAudience] = useState<readonly ClassificationPrincipal[]>([]);
	const [appliers, setAppliers] = useState<readonly ClassificationPrincipal[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [items, setItems] = useState<OrganizationClassification | null>(null);
	const select = (item: OrganizationClassification | null) => {
		setSelected(item);
		setName(item?.name ?? "");
		setColor(item?.color ?? "");
		setDescription(item?.description ?? "");
		setAudience(item?.audience ?? []);
		setAppliers(item?.appliers ?? []);
		setItems(null);
		setEditing(true);
	};
	const save = async (archive = false) => {
		setBusy(true);
		setError(null);
		const path = selected ? `/api/classifications/${encodeURIComponent(selected.id)}` : "/api/classifications";
		const result = await getJSONResult(path, {
			method: selected ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				selected
					? { name, color: color || null, description, ...(archive ? { archived: true } : {}) }
					: {
							name,
							color: color || undefined,
							description,
							audience: audience.map(({ kind, id }) => ({ kind, id })),
							appliers: appliers.map(({ kind, id }) => ({ kind, id })),
						},
			),
		});
		if (result.data && selected && !archive && selected.audience !== undefined && selected.appliers !== undefined) {
			for (const [suffix, values] of [
				["audience", audience],
				["appliers", appliers],
			] as const) {
				const saved = await getJSONResult(`${path}/${suffix}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(values.map(({ kind, id }) => ({ kind, id }))),
				});
				if (saved.error) {
					setError(`${suffix} was not saved: ${saved.error}`);
					setBusy(false);
					refresh();
					return;
				}
			}
		}
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setEditing(false);
			refresh();
		}
	};
	const listItems = async (item: OrganizationClassification) => {
		setSelected(item);
		setEditing(false);
		setItems(item);
	};
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock
				title="Classifications"
				description="A classification audience is the security boundary. Administrative roles do not bypass it."
			>
				<div className="hidden sm:block">
					<OrganizationTable
						columns={[
							"Name",
							"Description",
							...(classifications.some((item) => item.audience !== undefined) ? ["Audience"] : []),
							"State",
							"Actions",
						]}
					>
						{classifications.map((item) => (
							<tr key={item.id} className={rowClass}>
								<td className={cellClass}>{item.name}</td>
								<td className={cellClass}>
									{item.description || <span className="text-muted-foreground">No description</span>}
								</td>
								{classifications.some((definition) => definition.audience !== undefined) && (
									<td className={cellClass}>
										{item.audience?.map((principal) => (
											<span key={`${principal.kind}:${principal.id}`} title={principal.id} className="mr-2">
												{principal.displayName ?? displayLabel(principal.kind)}
											</span>
										)) ?? "Unavailable"}
									</td>
								)}
								<td className={cellClass}>{item.archived_at ? "Archived" : "Active"}</td>
								<td className={cellClass}>
									<div className="flex gap-2">
										<Action secondary onClick={() => void listItems(item)}>
											Items
										</Action>
										{canManage && (
											<Action secondary onClick={() => select(item)}>
												Edit
											</Action>
										)}
									</div>
								</td>
							</tr>
						))}
					</OrganizationTable>
				</div>
				<ul className="m-0 list-none divide-y p-0 sm:hidden">
					{classifications.map((item) => (
						<li key={item.id} className="space-y-3 py-4">
							<div className="flex items-center justify-between gap-3">
								<span className="text-small font-medium">{item.name}</span>
								<span className="text-xs text-muted-foreground">{item.archived_at ? "Archived" : "Active"}</span>
							</div>
							<p className="m-0 text-small text-muted-foreground">{item.description || "No description"}</p>
							{item.audience && (
								<p className="text-small">
									<span className="text-muted-foreground">Audience: </span>
									{item.audience.map((principal) => principal.displayName ?? displayLabel(principal.kind)).join(", ") ||
										"No audience"}
								</p>
							)}
							<div className="flex gap-2">
								<Action secondary onClick={() => void listItems(item)}>
									Items
								</Action>
								{canManage && (
									<Action secondary onClick={() => select(item)}>
										Edit
									</Action>
								)}
							</div>
						</li>
					))}
				</ul>
				{canManage && <Action onClick={() => select(null)}>Create classification</Action>}
			</OrganizationBlock>
			{editing && canManage && (
				<OrganizationBlock title={selected ? `Edit ${selected.name}` : "New classification"}>
					<TextField label="Classification name" value={name} onChange={setName} />
					<TextField label="Classification color" value={color} onChange={setColor} />
					<TextField label="Classification description" value={description} onChange={setDescription} />
					{!selected || (selected.audience !== undefined && selected.appliers !== undefined) ? (
						<>
							<PrincipalEditor title="Audience" values={audience} onChange={setAudience} />
							<PrincipalEditor title="Appliers" values={appliers} onChange={setAppliers} />
							<p className="settings-row-description">
								An empty appliers list allows material owners to apply this classification.
							</p>
						</>
					) : (
						<p role="status" className="settings-row-description">
							Audience editing is unavailable: the daemon did not return its current principals. Existing membership
							will not be overwritten.
						</p>
					)}
					<Action disabled={busy || !name.trim()} onClick={() => void save()}>
						Save classification
					</Action>
					{selected && (
						<Action
							secondary
							disabled={busy}
							onClick={() => {
								if (window.confirm(`Archive ${selected.name}? Existing assignments remain in force.`)) void save(true);
							}}
						>
							Archive classification
						</Action>
					)}
					<Action secondary onClick={() => setEditing(false)}>
						Cancel edit
					</Action>
				</OrganizationBlock>
			)}
			{items !== null && <ClassificationItems key={items.id} classification={items} />}
			<Message error={error} />
		</div>
	);
}
