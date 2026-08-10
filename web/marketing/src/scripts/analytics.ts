import posthog from "posthog-js";

const POSTHOG_API_KEY = import.meta.env.PUBLIC_POSTHOG_API_KEY ?? "phc_mLsvJmbmp6e9UarrX9Cq5QtTjVNiiphM9mvi5Xnddd8Q";
const POSTHOG_HOST = import.meta.env.PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const SURFACE = "marketing";
const LIBRARY = "signet-web";
const LIBRARY_VERSION = "1";

const EVENT_NAMES = {
	pageView: "marketing.page_view",
	ctaClicked: "marketing.cta_clicked",
	harnessSelected: "marketing.harness_selected",
	installSurfaceOpened: "marketing.install_surface_opened",
	commandCopied: "marketing.command_copied",
	guideOpened: "marketing.guide_opened",
	docsSearchState: "marketing.docs_search_state",
	outboundClicked: "marketing.outbound_clicked",
} as const;

type DocsSearchState = "results" | "empty" | "unavailable";

interface DocsSearchDetail {
	readonly state: DocsSearchState;
	readonly resultCountBucket: "0" | "1-3" | "4-8";
	readonly queryLengthBucket: "0-1" | "2-5" | "6+";
}

let lastPageViewPath = "";
let lastDocsSearchState = "";

function pageCategory(pathname: string): string {
	if (pathname === "/") return "home";
	if (pathname.startsWith("/blog/")) return "blog_article";
	if (pathname === "/blog" || pathname === "/blog/") return "blog_index";
	if (pathname === "/how-it-works" || pathname === "/how-it-works/") return "architecture";
	if (pathname === "/join" || pathname === "/join/") return "join";
	if (pathname === "/404" || pathname === "/404/") return "not_found";
	return "site";
}

function destinationCategory(hostname: string): string {
	const host = hostname.toLowerCase();
	if (host === "docs.signetai.sh") return "docs";
	if (host === "github.com" || host.endsWith(".github.com")) return "github";
	if (host === "discord.gg" || host.endsWith(".discord.com")) return "discord";
	if (host === "npmjs.com" || host.endsWith(".npmjs.com")) return "npm";
	if (host === "x.com" || host === "twitter.com") return "social";
	return "external";
}

function pageContext(): { pageCategory: string; pagePath: string } {
	return {
		pageCategory: pageCategory(window.location.pathname),
		pagePath: window.location.pathname,
	};
}

function capture(eventName: string, properties: Record<string, unknown> = {}): void {
	posthog.capture(eventName, {
		...properties,
		surface: SURFACE,
		$lib: LIBRARY,
	});
}

function trackPageView(): void {
	const path = window.location.pathname;
	if (path === lastPageViewPath) return;
	lastPageViewPath = path;
	capture(EVENT_NAMES.pageView, {
		...pageContext(),
	});
}

function trackDocsSearchState(detail: DocsSearchDetail): void {
	const stateKey = `${detail.state}:${detail.resultCountBucket}:${detail.queryLengthBucket}`;
	if (stateKey === lastDocsSearchState) return;
	lastDocsSearchState = stateKey;
	capture(EVENT_NAMES.docsSearchState, {
		state: detail.state,
		resultCountBucket: detail.resultCountBucket,
		queryLengthBucket: detail.queryLengthBucket,
	});
}

function isDocsGuide(url: URL): boolean {
	return url.hostname === "docs.signetai.sh";
}

function trackClick(event: MouseEvent): void {
	if (!(event.target instanceof Element)) return;
	const target = event.target.closest<HTMLElement>("a, button");
	if (!target) return;

	const cta = target.dataset.analyticsCta;
	if (cta) {
		capture(EVENT_NAMES.ctaClicked, {
			...pageContext(),
			cta,
			placement: target.dataset.analyticsPlacement ?? "site",
		});
	}

	const harness = target.dataset.analyticsHarness;
	if (harness) {
		capture(EVENT_NAMES.harnessSelected, {
			...pageContext(),
			harness,
		});
	}

	const installSurface = target.dataset.analyticsInstallSurface;
	if (installSurface) {
		capture(EVENT_NAMES.installSurfaceOpened, {
			...pageContext(),
			surfaceName: installSurface,
			option: target.dataset.analyticsInstallOption ?? "default",
		});
	}

	const guide = target.dataset.analyticsGuide;
	const href = target.getAttribute("href");
	if (href) {
		try {
			const url = new URL(href, window.location.href);
			if (guide || isDocsGuide(url)) {
				capture(EVENT_NAMES.guideOpened, {
					...pageContext(),
					guide: guide ?? "documentation",
					destination: destinationCategory(url.hostname),
				});
			}

			if (
				!cta &&
				!harness &&
				!guide &&
				!isDocsGuide(url) &&
				url.origin !== window.location.origin &&
				(url.protocol === "http:" || url.protocol === "https:")
			) {
				capture(EVENT_NAMES.outboundClicked, {
					...pageContext(),
					destination: destinationCategory(url.hostname),
				});
			}
		} catch {
			// Ignore malformed or non-navigation hrefs.
		}
	}
}

function onCustomEvent(event: Event): void {
	if (event.type === "signet:command-copied") {
		const detail = (event as CustomEvent<{ commandKind?: string; placement?: string }>).detail;
		capture(EVENT_NAMES.commandCopied, {
			...pageContext(),
			commandKind: detail.commandKind ?? "unknown",
			placement: detail.placement ?? "site",
		});
		return;
	}

	if (event.type === "signet:docs-search-state") {
		const detail = (event as CustomEvent<DocsSearchDetail>).detail;
		if (detail?.state && detail?.resultCountBucket && detail?.queryLengthBucket) {
			trackDocsSearchState(detail);
		}
	}
}

if (POSTHOG_API_KEY) {
	posthog.init(POSTHOG_API_KEY, {
		api_host: POSTHOG_HOST,
		autocapture: false,
		capture_pageview: false,
		capture_pageleave: false,
		capture_performance: false,
		capture_heatmaps: false,
		enable_recording_console_log: false,
		advanced_disable_flags: true,
		before_send: (event) => {
			if (!event) return null;
			event.properties = {
				...event.properties,
				surface: SURFACE,
				$lib: LIBRARY,
			};
			return event;
		},
		disable_session_recording: true,
		disable_surveys: true,
		person_profiles: "identified_only",
		persistence: "localStorage",
	});
	posthog._overrideSDKInfo(LIBRARY, LIBRARY_VERSION);

	document.addEventListener("click", trackClick);
	window.addEventListener("signet:command-copied", onCustomEvent);
	window.addEventListener("signet:docs-search-state", onCustomEvent);
	document.addEventListener("astro:page-load", trackPageView);
	trackPageView();
}
