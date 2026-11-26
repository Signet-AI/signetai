import { useState } from "react";
import { Panel } from "@/components/shell/panel";
import { usePanelQuery } from "@/lib/use-panel-query";
import { Action, TextField } from "./controls";

export interface LookupPerson {
	readonly id: string;
	readonly displayName: string;
	readonly email: string | null;
}
export function UserLookup({
	label,
	onSelect,
	onSearch,
}: {
	label: string;
	onSelect: (person: LookupPerson) => void;
	onSearch?: () => void;
}) {
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState("");
	const [history, setHistory] = useState<readonly string[]>([]);
	const [selected, setSelected] = useState("");
	const result = usePanelQuery<{ users: readonly LookupPerson[]; nextCursor: string | null }>(
		query.trim()
			? `/api/org/users/lookup?q=${encodeURIComponent(query)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
			: null,
	);
	return (
		<div className="flex flex-col gap-3">
			<TextField
				label={label}
				value={query}
				onChange={(value) => {
					setQuery(value);
					setCursor("");
					setHistory([]);
					setSelected("");
					onSearch?.();
				}}
			/>
			{!query.trim() ? (
				<p className="settings-row-description">Search by name or email.</p>
			) : (
				<Panel
					result={result.result}
					empty={result.result?.data?.users.length === 0}
					emptyMessage="No matching people."
					onRetry={result.refresh}
				>
					{(data) => (
						<div role="listbox" aria-label={label} className="max-h-48 overflow-y-auto divide-y">
							{data.users.map((person) => (
								<button
									type="button"
									role="option"
									aria-selected={selected === person.id}
									key={person.id}
									className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-small hover:bg-muted"
									onClick={() => {
										setSelected(person.id);
										onSelect(person);
									}}
								>
									<span>{person.displayName}</span>
									{person.email && <span className="text-muted-foreground">{person.email}</span>}
								</button>
							))}
						</div>
					)}
				</Panel>
			)}
			{query.trim() && (
				<div className="flex gap-2">
					<Action
						secondary
						disabled={!history.length}
						onClick={() => {
							setCursor(history.at(-1) ?? "");
							setHistory(history.slice(0, -1));
						}}
					>
						Previous people
					</Action>
					<Action
						secondary
						disabled={!result.result?.data?.nextCursor}
						onClick={() => {
							const next = result.result?.data?.nextCursor;
							if (next) {
								setHistory([...history, cursor]);
								setCursor(next);
							}
						}}
					>
						Next people
					</Action>
				</div>
			)}
		</div>
	);
}
