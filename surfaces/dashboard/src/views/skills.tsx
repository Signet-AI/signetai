import { MessageResponse } from "@/components/ai-elements/message";
import { PageHeading } from "@/components/dashboard/heading";
import { ArrowLeft, Search } from "@/components/mingcute-icons";
import { type Skill, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useScrollEnd } from "@/lib/use-scroll-end";
import { useEffect, useMemo, useRef, useState } from "react";

export function SkillsView() {
	const skills = useAsync(() => api.getSkills(), { key: "skills" });
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listScroll = useScrollEnd<HTMLUListElement>(`${skills.data?.length}:${query}`);

	const filtered = useMemo(() => filterSkills(skills.data ?? [], query), [skills.data, query]);
	const active = selected ?? filtered[0]?.name ?? null;

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, [contenteditable='true']")) return;
			event.preventDefault();
			searchRef.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const count = skills.data?.length ?? 0;
	return (
		<div className="skills-page">
			<div className="skills-content">
				<PageHeading
					title="Skills"
					description={
						skills.data
							? `${count} installed. Instructions your agents load when a task calls for them.`
							: "Instructions your agents load when a task calls for them."
					}
				/>
				<div className="skills-layout" data-detail={selected ? "open" : "closed"}>
					<section className="skills-library" aria-label="Installed skills">
						<search className="skills-search">
							<Search className="size-3.5 shrink-0" aria-hidden="true" />
							<input
								ref={searchRef}
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search skills"
								aria-label="Search skills"
							/>
							{!query && <kbd>/</kbd>}
						</search>
						{skills.loading && !skills.data ? (
							<p className="skills-note">Loading skills…</p>
						) : !skills.data ? (
							<p className="skills-note">The daemon didn't return a skill list.</p>
						) : filtered.length === 0 ? (
							<p className="skills-note">{query ? `No skills match "${query}".` : "No skills installed yet."}</p>
						) : (
							<ul
								ref={listScroll.ref}
								onScroll={listScroll.onScroll}
								data-at-end={listScroll.atEnd}
								className="skills-list"
							>
								{filtered.map((skill) => (
									<li key={skill.name}>
										<button
											type="button"
											className="skills-row"
											aria-current={skill.name === active ? "true" : undefined}
											onClick={() => setSelected(skill.name)}
										>
											<span className="skills-row-name">
												<span className="truncate">{skill.name}</span>
												{skill.userInvocable && <span className="skills-chip">Command</span>}
											</span>
											<span className="skills-row-description">{firstSentence(skill.description)}</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</section>
					{active && <SkillDetailPane key={active} name={active} onBack={() => setSelected(null)} />}
				</div>
			</div>
		</div>
	);
}

function SkillDetailPane({ name, onBack }: { name: string; onBack: () => void }) {
	const detail = useAsync(() => api.getSkill(name), { key: `skill:${name}` });
	const body = useMemo(() => (detail.data ? stripFrontmatter(detail.data.content) : ""), [detail.data]);
	const scroll = useScrollEnd<HTMLDivElement>(body);
	const skill = detail.data;
	const meta = [skill?.version && `v${skill.version}`, skill?.author].filter(Boolean).join(" · ");

	return (
		<article className="skills-detail" aria-labelledby="skills-detail-title">
			<button type="button" className="skills-back" onClick={onBack}>
				<ArrowLeft className="size-3.5" aria-hidden="true" />
				All skills
			</button>
			<header className="skills-detail-head">
				<h2 id="skills-detail-title">{name}</h2>
				{(meta || skill?.userInvocable) && (
					<p className="skills-detail-meta">
						{meta}
						{skill?.userInvocable && (
							<span className="skills-chip">
								/{name}
								{skill.argHint ? ` ${skill.argHint}` : ""}
							</span>
						)}
					</p>
				)}
				{skill?.description && <p className="skills-detail-description">{skill.description}</p>}
				{skill?.path && <code className="skills-detail-path">{skill.path}</code>}
			</header>
			<div ref={scroll.ref} onScroll={scroll.onScroll} data-at-end={scroll.atEnd} className="skills-detail-body">
				{detail.loading && !skill ? (
					<p className="skills-note">Loading SKILL.md…</p>
				) : !skill ? (
					<p className="skills-note">This skill's SKILL.md couldn't be read.</p>
				) : body ? (
					<MessageResponse className="skills-markdown">{body}</MessageResponse>
				) : (
					<p className="skills-note">SKILL.md has no instructions beyond its frontmatter.</p>
				)}
			</div>
		</article>
	);
}

export function filterSkills(skills: readonly Skill[], query: string): readonly Skill[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return skills;
	const byName = skills.filter((skill) => skill.name.toLowerCase().includes(needle));
	const byDescription = skills.filter(
		(skill) => !skill.name.toLowerCase().includes(needle) && skill.description.toLowerCase().includes(needle),
	);
	return [...byName, ...byDescription];
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function firstSentence(text: string): string {
	const match = /^(.+?[.!?])(\s|$)/.exec(text);
	return match ? match[1] : text;
}
