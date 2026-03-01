let cleanup: (() => void) | null = null;

function clearActive(links: HTMLAnchorElement[]): void {
	for (const link of links) {
		link.classList.remove("is-active");
	}
}

function setActive(links: HTMLAnchorElement[], id: string): void {
	clearActive(links);
	for (const link of links) {
		const href = link.getAttribute("href");
		if (href === `#${id}`) {
			link.classList.add("is-active");
			return;
		}
	}
}

function getIdFromHash(hash: string): string {
	return hash.startsWith("#") ? hash.slice(1) : hash;
}

function initDocsToc(): void {
	cleanup?.();
	cleanup = null;

	const nav = document.querySelector(".docs-inpage");
	if (!(nav instanceof HTMLElement)) return;

	const linkNodes = nav.querySelectorAll('a[href^="#"]');
	const links: HTMLAnchorElement[] = [];
	const headings: HTMLElement[] = [];

	for (const node of linkNodes) {
		if (!(node instanceof HTMLAnchorElement)) continue;
		const hash = node.getAttribute("href");
		if (!hash) continue;
		const id = getIdFromHash(hash);
		if (!id) continue;

		const heading = document.getElementById(id);
		if (!(heading instanceof HTMLElement)) continue;

		links.push(node);
		headings.push(heading);
	}

	if (links.length === 0 || headings.length === 0) return;

	const onScroll = () => {
		const marker = window.scrollY + 140;
		let current = headings[0];

		for (const heading of headings) {
			if (heading.offsetTop <= marker) {
				current = heading;
			}
		}

		if (current.id) {
			setActive(links, current.id);
		}
	};

	let ticking = false;
	const onScrollThrottled = () => {
		if (ticking) return;
		ticking = true;
		window.requestAnimationFrame(() => {
			onScroll();
			ticking = false;
		});
	};

	const onHashChange = () => {
		const id = getIdFromHash(window.location.hash);
		if (!id) return;
		setActive(links, id);
	};

	const onClick = (event: Event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const link = target.closest('a[href^="#"]');
		if (!(link instanceof HTMLAnchorElement)) return;
		const href = link.getAttribute("href");
		if (!href) return;
		const id = getIdFromHash(href);
		if (!id) return;
		setActive(links, id);
	};

	const initialHash = getIdFromHash(window.location.hash);
	if (initialHash) {
		setActive(links, initialHash);
	}

	window.addEventListener("scroll", onScrollThrottled, { passive: true });
	window.addEventListener("hashchange", onHashChange);
	nav.addEventListener("click", onClick);
	onScroll();

	cleanup = () => {
		window.removeEventListener("scroll", onScrollThrottled);
		window.removeEventListener("hashchange", onHashChange);
		nav.removeEventListener("click", onClick);
	};

	document.addEventListener(
		"astro:before-swap",
		() => {
			cleanup?.();
			cleanup = null;
		},
		{ once: true },
	);
}

initDocsToc();
document.addEventListener("astro:page-load", initDocsToc);
