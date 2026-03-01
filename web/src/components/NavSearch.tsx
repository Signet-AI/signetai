import { SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function NavSearch() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		const id = window.setTimeout(() => {
			inputRef.current?.focus();
		}, 80);
		return () => window.clearTimeout(id);
	}, [open]);

	useEffect(() => {
		if (!open) return;

		const onMouseDown = (event: MouseEvent) => {
			const root = rootRef.current;
			if (!root) return;
			if (event.target instanceof Node && root.contains(event.target)) return;
			setOpen(false);
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};

		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onEscape);
		};
	}, [open]);

	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = query.trim();
		if (!trimmed) {
			window.location.href = "/docs";
			return;
		}

		const params = new URLSearchParams();
		params.set("q", trimmed);
		window.location.href = `/docs?${params.toString()}`;
	};

	return (
		<div
			ref={rootRef}
			className={`nav-search ${open ? "is-open" : ""}`}
			role="search"
			aria-label="Search documentation"
		>
			<Button
				variant="outline"
				size="icon-sm"
				type="button"
				className="nav-search-trigger"
				aria-label={open ? "Close docs search" : "Open docs search"}
				onClick={() => setOpen((value) => !value)}
			>
				<SearchIcon />
			</Button>

			<form className="nav-search-form" onSubmit={onSubmit}>
				<Input
					ref={inputRef}
					className="nav-search-input"
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search docs"
					autoComplete="off"
					tabIndex={open ? 0 : -1}
					aria-hidden={!open}
					aria-label="Search docs"
				/>
			</form>
		</div>
	);
}
