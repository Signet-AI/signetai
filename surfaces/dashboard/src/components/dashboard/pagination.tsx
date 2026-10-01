import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function usePagination<T>(items: readonly T[], count: number) {
	const [index, setPage] = useState(0);
	const pages = Math.max(1, Math.ceil(items.length / count));
	const page = Math.min(index, pages - 1);
	return { page, pages, setPage, visible: items.slice(page * count, (page + 1) * count) };
}

export function useBoundedPagination<T>(items: readonly T[], rowHeight: number, reservedHeight = 0) {
	const ref = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(180);
	useEffect(() => {
		if (!ref.current || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
		observer.observe(ref.current);
		return () => observer.disconnect();
	}, []);
	const count = Math.max(1, Math.floor((height - reservedHeight) / rowHeight));
	return { ref, ...usePagination(items, count) };
}

type PaginationProps = {
	page: number;
	pages: number;
	onPage: (page: number) => void;
};

export function TextPageControls({ page, pages, onPage, className }: PaginationProps & { className?: string }) {
	if (pages <= 1) return null;
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<Button variant="ghost" size="compact" disabled={page === 0} onClick={() => onPage(page - 1)}>
				Previous
			</Button>
			<span>
				{page + 1} / {pages}
			</span>
			<Button variant="ghost" size="compact" disabled={page === pages - 1} onClick={() => onPage(page + 1)}>
				Next
			</Button>
		</div>
	);
}

export function PageControls({ page, pages, onPage, label }: PaginationProps & { label: string }) {
	return (
		<div className="dashboard-pagination">
			<span>
				{page + 1} / {pages}
			</span>
			<div className="flex gap-2">
				<button type="button" aria-label={`Previous ${label}`} disabled={page === 0} onClick={() => onPage(page - 1)}>
					‹
				</button>
				<button
					type="button"
					aria-label={`Next ${label}`}
					disabled={page >= pages - 1}
					onClick={() => onPage(page + 1)}
				>
					›
				</button>
			</div>
		</div>
	);
}
