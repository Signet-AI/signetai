import { useId, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Panel } from "@/components/shell/panel";
import { usePanelQuery } from "@/lib/use-panel-query";
import type { LookupPerson } from "./user-lookup";
export interface AuthorOption {
	readonly value: string;
	readonly label: string;
	readonly unavailable?: boolean;
}
export function FilterToolbar({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<div role="toolbar" aria-label="Filters" className="hidden flex-wrap items-center gap-2 sm:flex">
				{children}
			</div>
			<div className="sm:hidden">
				<Button variant="outline" size="compact" onClick={() => setOpen(true)}>
					Filters
				</Button>
			</div>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="[&_.home-source-filter]:w-full! top-0 right-0 left-auto flex h-dvh w-full max-w-sm translate-x-0 translate-y-0 flex-col rounded-none">
					<DialogTitle>Filters</DialogTitle>
					<DialogDescription className="sr-only">Filter the items in this list.</DialogDescription>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">{children}</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
export function FilterSearch({
	value,
	onChange,
	label,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
}) {
	return (
		<SearchField
			className="min-w-0 shrink-0 sm:min-w-40 sm:flex-1"
			aria-label={label}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			placeholder={label}
		/>
	);
}
export function AuthorFilter({
	value,
	options,
	remote = false,
	onChange,
}: {
	value: string;
	options: readonly AuthorOption[];
	remote?: boolean;
	onChange: (value: string, person?: LookupPerson) => void;
}) {
	const [open, setOpen] = useState(false),
		[query, setQuery] = useState(""),
		[cursor, setCursor] = useState("");
	const [active, setActive] = useState(-1);
	const listId = useId();
	const lookup = usePanelQuery<{ users: readonly LookupPerson[]; nextCursor: string | null }>(
		remote && open && query.trim()
			? `/api/org/users/lookup?q=${encodeURIComponent(query)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
			: null,
	);
	const people = lookup.result?.data?.users ?? [];
	const remoteSearch = remote && !!query.trim();
	const choices: readonly (AuthorOption & { person?: LookupPerson })[] = remoteSearch
		? people.map((person) => ({ value: person.id, label: person.displayName, person }))
		: options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()));
	const select = (option: AuthorOption & { person?: LookupPerson }) => {
		onChange(option.value, option.person);
		setOpen(false);
	};
	const list = (
		<div id={listId} role="listbox" aria-label="Authors" className="max-h-48 overflow-y-auto">
			{choices.map((option, index) => (
				<button
					key={option.value}
					id={`${listId}-${index}`}
					type="button"
					role="option"
					aria-selected={value === option.value}
					className={`flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-small ${active === index ? "bg-muted" : "hover:bg-muted"}`}
					onClick={() => select(option)}
				>
					<span className={option.unavailable ? "italic text-muted-foreground" : undefined}>{option.label}</span>
					{option.person?.email && <span className="text-muted-foreground">{option.person.email}</span>}
				</button>
			))}
			{!remoteSearch && !choices.length && <p className="p-2 text-small text-muted-foreground">No matching people.</p>}
		</div>
	);
	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setQuery("");
				setCursor("");
				setActive(-1);
			}}
		>
			<Popover.Trigger asChild>
				<Button
					variant="outline"
					size="compact"
					role="combobox"
					aria-label="Author"
					aria-controls={listId}
					aria-expanded={open}
					aria-haspopup="listbox"
					className="home-source-filter justify-between"
				>
					{options.find((option) => option.value === value)?.unavailable ||
					(value && !options.some((option) => option.value === value)) ? (
						<span className="italic text-muted-foreground">Another person</span>
					) : (
						(options.find((option) => option.value === value)?.label ?? "All authors")
					)}
					<span aria-hidden="true">⌄</span>
				</Button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={4}
					className="z-50 w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
				>
					<SearchField
						aria-label="Search authors"
						placeholder="Search authors"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setCursor("");
							setActive(-1);
						}}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								setActive(Math.min(active + 1, choices.length - 1));
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setActive(Math.max(active - 1, 0));
							} else if (event.key === "Enter" && active >= 0) {
								event.preventDefault();
								const option = choices[active];
								if (option) select(option);
							}
						}}
						aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
					/>
					{remoteSearch ? (
						<Panel
							result={lookup.result}
							empty={!choices.length}
							emptyMessage="No matching people."
							onRetry={lookup.refresh}
						>
							{() => list}
						</Panel>
					) : (
						list
					)}
					{remoteSearch && lookup.result?.data?.nextCursor && (
						<Button
							variant="outline"
							size="compact"
							onClick={() => {
								const next = lookup.result?.data?.nextCursor;
								if (next) {
									setCursor(next);
									setActive(-1);
								}
							}}
						>
							Next people
						</Button>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
