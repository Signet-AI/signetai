let cleanupReveal: (() => void) | null = null;

export function initReveal(): void {
	if (typeof cleanupReveal === "function") {
		cleanupReveal();
		cleanupReveal = null;
	}

	const revealNodes = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
	if (revealNodes.length === 0) return;

	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		revealNodes.forEach((node) => node.classList.add("is-visible"));
		return;
	}

	const observer = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				if (!entry.isIntersecting) return;

				const node = entry.target;
				if (!(node instanceof HTMLElement)) return;
				node.classList.add("is-visible");
				observer.unobserve(node);
			});
		},
		{
			threshold: 0.12,
			rootMargin: "0px 0px -8% 0px",
		},
	);

	revealNodes.forEach((node) => {
		node.classList.remove("is-visible");
		observer.observe(node);
	});

	cleanupReveal = () => observer.disconnect();
}
