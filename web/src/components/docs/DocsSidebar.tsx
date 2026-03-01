import { useState } from "react";
import { ChevronDown, Menu } from "lucide-react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "../ui/sheet";
import DocSearch from "./DocSearch";

interface NavItem {
	readonly title: string;
	readonly slug: string;
	readonly url: string;
}

interface NavSection {
	readonly label: string;
	readonly items: readonly NavItem[];
}

interface DocsSidebarProps {
	sections: NavSection[];
	currentSlug?: string;
}

function sectionContainsSlug(section: NavSection, slug?: string): boolean {
	if (!slug) return false;
	return section.items.some((item) => item.slug === slug);
}

function SidebarSections({
	sections,
	currentSlug,
	onNavigate,
}: {
	sections: NavSection[];
	currentSlug?: string;
	onNavigate?: () => void;
}) {
	return (
		<div className="docs-sidebar-sections">
			{sections.map((section) => {
				const isActiveSection = sectionContainsSlug(section, currentSlug);

				return (
					<Collapsible
						key={section.label}
						defaultOpen={isActiveSection}
						className="sidebar-collapsible-section"
					>
						<CollapsibleTrigger className="sidebar-section-trigger">
							<span
								className="sidebar-section-label"
								data-active={isActiveSection || undefined}
							>
								{section.label}
								<span className="sidebar-section-count">
									{section.items.length}
								</span>
							</span>
							<ChevronDown
								size={14}
								className="sidebar-chevron"
								aria-hidden="true"
							/>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<ul className="sidebar-nav">
								{section.items.map((item) => {
									const isCurrent = item.slug === currentSlug;
									return (
										<li key={item.slug}>
											<a
												href={item.url}
												aria-current={isCurrent ? "page" : undefined}
												onClick={onNavigate}
											>
												{item.title}
											</a>
										</li>
									);
								})}
							</ul>
						</CollapsibleContent>
					</Collapsible>
				);
			})}
		</div>
	);
}

export default function DocsSidebar({
	sections,
	currentSlug,
}: DocsSidebarProps) {
	const [sheetOpen, setSheetOpen] = useState(false);

	return (
		<>
			{/* Desktop sidebar */}
			<aside className="docs-sidebar docs-sidebar-desktop">
				<a
					href="/docs"
					className="docs-home-link"
					aria-current={!currentSlug ? "page" : undefined}
				>
					Docs Home
				</a>

				<DocSearch />

				<SidebarSections sections={sections} currentSlug={currentSlug} />
			</aside>

			{/* Mobile trigger + sheet */}
			<div className="docs-mobile-nav">
				<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
					<SheetTrigger className="docs-mobile-trigger" aria-label="Open navigation">
						<Menu size={20} />
						<span>Menu</span>
					</SheetTrigger>
					<SheetContent
						side="left"
						className="docs-sheet-content"
						showCloseButton={true}
					>
						<SheetTitle className="sr-only">Documentation navigation</SheetTitle>
						<a
							href="/docs"
							className="docs-home-link"
							aria-current={!currentSlug ? "page" : undefined}
							onClick={() => setSheetOpen(false)}
						>
							Docs Home
						</a>

						<SidebarSections
							sections={sections}
							currentSlug={currentSlug}
							onNavigate={() => setSheetOpen(false)}
						/>
					</SheetContent>
				</Sheet>
			</div>
		</>
	);
}
