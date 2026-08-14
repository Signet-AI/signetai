let cleanupReveal: (() => void) | null = null;

export function initReveal(): void {
	if (typeof cleanupReveal === "function") {
		cleanupReveal();
		cleanupReveal = null;
	}

	const revealNodes = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
	if (revealNodes.length === 0) return;

	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		for (const node of revealNodes) node.classList.add("is-visible");
		return;
	}

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;

				const node = entry.target;
				if (!(node instanceof HTMLElement)) continue;
				node.classList.add("is-visible");
				observer.unobserve(node);
			}
		},
		{
			threshold: 0.12,
			rootMargin: "0px 0px -8% 0px",
		},
	);

	for (const node of revealNodes) {
		node.classList.remove("is-visible");
		observer.observe(node);
	}

	cleanupReveal = () => observer.disconnect();
}
