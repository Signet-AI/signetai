import type { ReactNode } from "react";
import { Panel } from "@/components/shell/panel";
import { OrganizationTable, cellClass, rowClass, displayLabel } from "./controls";

export interface EvidenceListRow {
	readonly key: string;
	readonly title: string;
	readonly kind: string;
	readonly agent: string;
	readonly author?: string;
	readonly authorUnavailable?: boolean;
	readonly team?: string;
	readonly identifier?: string;
	readonly badges?: ReactNode;
	readonly onOpen?: () => void;
}
export function EvidenceList({ rows, noun = "Item" }: { rows: readonly EvidenceListRow[]; noun?: string }) {
	if (!rows.length)
		return (
			<Panel
				result={{ data: rows, error: null, status: 200 }}
				empty
				emptyMessage={`No ${noun === "Memory" ? "memories" : `${noun.toLowerCase()}s`} yet`}
			>
				{() => null}
			</Panel>
		);
	const author = (row: EvidenceListRow) =>
		row.authorUnavailable ? (
			<span className="italic text-muted-foreground" title="The author’s name is not available in this view.">
				Another person
			</span>
		) : (
			(row.author ?? "Not recorded")
		);
	const hasTeam = rows.some((row) => row.team !== undefined);
	const title = (row: EvidenceListRow) => (
		<div className="min-w-0">
			<div className="flex flex-wrap items-center gap-2">
				{row.onOpen ? (
					<button type="button" className="text-left hover:underline" onClick={row.onOpen}>
						{row.title}
					</button>
				) : (
					row.title
				)}
				{row.badges}
			</div>
			{row.identifier && <p className="m-0 mt-1 break-all text-xs text-muted-foreground">{row.identifier}</p>}
		</div>
	);
	return (
		<>
			<div className="hidden sm:block">
				<OrganizationTable columns={[noun, "Kind", "Author", "Agent", ...(hasTeam ? ["Team"] : [])]}>
					{rows.map((row) => (
						<tr key={row.key} className={rowClass}>
							<td className={cellClass}>{title(row)}</td>
							<td className={cellClass}>{displayLabel(row.kind)}</td>
							<td className={cellClass}>{author(row)}</td>
							<td className={cellClass}>{row.agent}</td>
							{hasTeam && <td className={cellClass}>{row.team ?? "Not recorded"}</td>}
						</tr>
					))}
				</OrganizationTable>
			</div>
			<ul className="m-0 list-none divide-y p-0 sm:hidden">
				{rows.map((row) => (
					<li key={row.key} className="py-4">
						{title(row)}
						<p className="m-0 mt-2 text-small text-muted-foreground">
							{displayLabel(row.kind)} · {author(row)} · {row.agent}
							{row.team !== undefined ? ` · ${row.team}` : ""}
						</p>
					</li>
				))}
			</ul>
		</>
	);
}
