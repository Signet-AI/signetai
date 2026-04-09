import Fuse from "fuse.js";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface SearchItem {
	readonly title: string;
	readonly description: string;
	readonly section: string;
	readonly sectionTitle: string;
	readonly slug: string;
	readonly url: string;
	readonly excerpt: string;
}

interface SearchResult {
	item: SearchItem;
	score?: number;
}

export default function NavSearch() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResult[]>([]);
	const [selected, setSelected] = useState(0);
	const [fuse, setFuse] = useState<Fuse<SearchItem> | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const loadIndex = useCallback(async () => {
		if (fuse) return;
		try {
			const res = await fetch("/search.json");
			const data: SearchItem[] = await res.json();
			setFuse(
				new Fuse(data, {
					keys: [
						{ name: "title", weight: 0.35 },
						{ name: "sectionTitle", weight: 0.25 },
						{ name: "excerpt", weight: 0.25 },
						{ name: "description", weight: 0.1 },
						{ name: "section", weight: 0.05 },
					],
					threshold: 0.4,
					includeScore: true,
				}),
			);
		} catch {
			// search unavailable
		}
	}, [fuse]);

	// Toggle with keyboard shortcut
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((v) => !v);
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	// Focus input when opened
	useEffect(() => {
		if (!open) return;
		void loadIndex();
		const id = setTimeout(() => inputRef.current?.focus(), 80);
		return () => clearTimeout(id);
	}, [open, loadIndex]);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const onClick = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onEscape);
		};
	}, [open]);

	// Search on query change
	useEffect(() => {
		if (!fuse || query.length < 2) {
			setResults([]);
			return;
		}
		setResults(fuse.search(query).slice(0, 8));
		setSelected(0);
	}, [query, fuse]);

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelected((i) => Math.min(i + 1, results.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelected((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter" && results[selected]) {
			e.preventDefault();
			window.location.href = results[selected].item.url;
			setOpen(false);
		}
	}

	return (
		/* biome-ignore lint/a11y/useSemanticElements: search landmark is intentional for assistive technology navigation */
		<div ref={rootRef} className={`nav-search ${open ? "is-open" : ""}`} role="search">
			<button
				type="button"
				className="nav-search-trigger"
				aria-label={open ? "Close search" : "Search"}
				onClick={() => setOpen((v) => !v)}
			>
				<SearchIcon size={14} />
				<span className="nav-search-hint">Search</span>
				<kbd className="nav-search-kbd">
					{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘K" : "Ctrl+K"}
				</kbd>
			</button>

			{open && (
				<div className="nav-search-dropdown">
					<input
						ref={inputRef}
						type="text"
						className="nav-search-input"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Search docs..."
						autoComplete="off"
						aria-label="Search documentation"
						aria-expanded={results.length > 0}
						aria-controls="nav-search-results"
						aria-activedescendant={results[selected] ? `nav-search-option-${selected}` : undefined}
					/>
					{results.length > 0 && (
						/* biome-ignore lint/a11y/useSemanticElements: popup search results use listbox semantics for screen readers */
						<div id="nav-search-results" className="nav-search-results" role="listbox" tabIndex={-1}>
							{results.map((r, i) => {
								const option = (
									<div
										id={`nav-search-option-${i}`}
										key={r.item.slug}
										role="option"
										tabIndex={-1}
										aria-selected={i === selected}
										className={i === selected ? "selected" : ""}
									>
										<a href={r.item.url} onClick={() => setOpen(false)}>
											<span className="nav-search-result-title">{r.item.title}</span>
											<span className="nav-search-result-section">{r.item.sectionTitle || r.item.section || "Docs"}</span>
										</a>
									</div>
								);
								return option;
							})}
						</div>
					)}
					{query.length >= 2 && results.length === 0 && <div className="nav-search-empty">No results</div>}
				</div>
			)}
		</div>
	);
}
