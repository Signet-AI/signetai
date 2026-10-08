import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import {
	IDENTITY_FILES,
	IDENTITY_PRESETS,
	type IdentityPresetName,
} from "../../../../../platform/core/src/identity-spec";
import type { ConfigFile } from "@/lib/api";
import agentsTemplate from "../../../../cli/templates/AGENTS.md.template?raw";
import soulTemplate from "../../../../cli/templates/SOUL.md.template?raw";
import identityTemplate from "../../../../cli/templates/IDENTITY.md.template?raw";
import userTemplate from "../../../../cli/templates/USER.md.template?raw";
import heartbeatTemplate from "../../../../cli/templates/HEARTBEAT.md.template?raw";
import bootstrapTemplate from "../../../../cli/templates/BOOTSTRAP.md.template?raw";

const TEMPLATES: Record<string, string> = {
	"AGENTS.md": agentsTemplate,
	"SOUL.md": soulTemplate,
	"IDENTITY.md": identityTemplate,
	"USER.md": userTemplate,
	"HEARTBEAT.md": heartbeatTemplate,
	"BOOTSTRAP.md": bootstrapTemplate,
};
const MANAGED_FILES = new Set(["MEMORY.md", "BOOTSTRAP.md"]);
const FILES = Object.values(IDENTITY_FILES).filter((file) => !MANAGED_FILES.has(file.path));
export interface IdentityDraft {
	name: string;
	userName: string;
	preset: IdentityPresetName;
	managed: boolean;
	selected: string[];
	contents: Record<string, string>;
}
export function identityDraft(
	name: string,
	preset: IdentityPresetName,
	managed: boolean,
	files: ConfigFile[],
): IdentityDraft {
	return {
		name,
		userName: files.find((file) => file.name === "USER.md")?.content.match(/^- name:[ \t]*(.*)$/m)?.[1] ?? "",
		preset,
		managed,
		selected: [...IDENTITY_PRESETS[preset].startup, ...IDENTITY_PRESETS[preset].special].map((file) => file.path),
		contents: Object.fromEntries(files.map((file) => [file.name, file.content])),
	};
}
export function identityContent(draft: IdentityDraft, file: string): string {
	const existing = draft.contents[file];
	if (existing !== undefined) return existing;
	let content = (TEMPLATES[file] ?? "").replaceAll("{{AGENT_NAME}}", draft.name.trim() || "Your agent");
	if (file === "USER.md") content = content.replace(/^- name:[^\n]*$/m, () => `- name: ${draft.userName.trim()}`);
	if (file === "AGENTS.md") content = content.replace(/^- Name:[^\n]*$/m, () => `- Name: ${draft.userName.trim()}`);
	return content;
}

export function IdentityStep({
	value,
	onChange,
	disabled,
}: {
	value: IdentityDraft;
	onChange: (value: IdentityDraft) => void;
	disabled: boolean;
}) {
	const [file, setFile] = useState("AGENTS.md");
	const editable = value.selected.filter(
		(path) => !MANAGED_FILES.has(path) && !path.includes("/") && !path.includes(".."),
	);
	const activeFile = editable.includes(file) ? file : editable[0];
	return (
		<div className="identity-layout">
			<div className="identity-options">
				<label htmlFor="agent-name">Agent name</label>
				<input
					id="agent-name"
					className="memory-input"
					placeholder="What should your agent be called?"
					maxLength={80}
					value={value.name}
					disabled={disabled}
					onChange={(e) => onChange({ ...value, name: e.target.value })}
				/>
				<label htmlFor="user-name">
					Your name <span className="optional">optional</span>
				</label>
				<input
					id="user-name"
					className="memory-input"
					placeholder="What should it call you?"
					maxLength={80}
					value={value.userName}
					disabled={disabled}
					onChange={(e) =>
						onChange({
							...value,
							userName: e.target.value,
							contents: Object.fromEntries(
								Object.entries(value.contents).map(([path, content]) => {
									if (path === "USER.md")
										return [
											path,
											/^- name:[^\n]*$/m.test(content)
												? content.replace(/^- name:[^\n]*$/m, () => `- name: ${e.target.value.trim()}`)
												: `${content}\n- name: ${e.target.value.trim()}\n`,
										];
									if (path === "AGENTS.md")
										return [
											path,
											/^- Name:[^\n]*$/m.test(content)
												? content.replace(/^- Name:[^\n]*$/m, () => `- Name: ${e.target.value.trim()}`)
												: `${content}\nAbout Your User\n---\n\n- Name: ${e.target.value.trim()}\n`,
										];
									return [path, content];
								}),
							),
						})
					}
				/>
				<label htmlFor="identity-preset">Identity preset</label>
				<Select
					value={value.managed ? value.preset : "off"}
					disabled={disabled}
					onValueChange={(selectedPreset) => {
						if (selectedPreset === "off") {
							onChange({ ...value, managed: false });
							return;
						}
						const preset = selectedPreset as IdentityPresetName;
						onChange({
							...value,
							managed: true,
							preset,
							selected: [...IDENTITY_PRESETS[preset].startup, ...IDENTITY_PRESETS[preset].special].map(
								(entry) => entry.path,
							),
						});
					}}
				>
					<SelectTrigger id="identity-preset" aria-label="Identity preset" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						<SelectItem value="minimal">Minimal · instructions only</SelectItem>
						<SelectItem value="hermes">Hermes · personality + instructions</SelectItem>
						<SelectItem value="openclaw">OpenClaw · full identity</SelectItem>
						<SelectItem value="custom">Custom · choose your files</SelectItem>
						<SelectItem value="off">Keep identity in my existing tools</SelectItem>
					</SelectContent>
				</Select>
				{value.managed ? (
					<>
						<div className="identity-files-heading">Included files</div>
						<div className="identity-files">
							{FILES.map((entry) => (
								<label key={entry.path} title={entry.description}>
									<input
										type="checkbox"
										checked={value.selected.includes(entry.path)}
										disabled={disabled}
										onChange={(e) =>
											onChange({
												...value,
												preset: "custom",
												selected: e.target.checked
													? [...value.selected, entry.path]
													: value.selected.filter((path) => path !== entry.path),
											})
										}
									/>
									<span>{entry.path}</span>
									<small>{entry.context === "session" ? "Background" : "Conversation"}</small>
								</label>
							))}
						</div>
					</>
				) : (
					<p className="fixture">
						Signet will handle memory while your tools keep their existing identities. No identity files will be
						changed.
					</p>
				)}
			</div>
			<div className="identity-editor">
				{value.managed && activeFile ? (
					<>
						<label htmlFor="identity-file">Edit identity file</label>
						<Select value={activeFile} onValueChange={setFile} disabled={disabled}>
							<SelectTrigger id="identity-file" aria-label="Edit identity file" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent position="popper" align="start">
								{editable.map((path) => (
									<SelectItem key={path} value={path}>
										{path}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="fixture">{FILES.find((entry) => entry.path === activeFile)?.description}</p>
						<textarea
							aria-label={`${activeFile} content`}
							value={identityContent(value, activeFile)}
							disabled={disabled}
							maxLength={65_536}
							onChange={(e) => onChange({ ...value, contents: { ...value.contents, [activeFile]: e.target.value } })}
							spellCheck={false}
						/>
					</>
				) : (
					<p className="fixture">Choose identity files to preview and edit their contents.</p>
				)}
			</div>
		</div>
	);
}
