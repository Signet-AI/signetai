import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import YAML from "yaml";
export function parseSimpleYaml(text: string): Record<string, unknown> {
	try {
		const parsed = YAML.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function isYamlRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseRuntimeYaml(text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		const document = YAML.parseDocument(text, { logLevel: "silent", prettyErrors: false });
		if (document.errors.length > 0 || document.warnings.length > 0) {
			throw new Error("invalid YAML syntax");
		}
		parsed = document.toJS();
	} catch {
		throw new Error("invalid YAML syntax");
	}
	if (!isYamlRecord(parsed)) {
		throw new Error("top-level document must be a mapping");
	}
	return parsed;
}
export function parseYamlDocument(text: string): unknown {
	return YAML.parse(text);
}
export function stringifyYamlDocument(value: unknown): string {
	return YAML.stringify(value);
}
export function formatYaml(obj: Record<string, unknown>, _indent = 0): string {
	return YAML.stringify(obj, {
		indent: 2,
		simpleKeys: true,
	});
}

export interface YamlConfigEditor {
	get(path: readonly string[]): unknown;
	set(path: readonly string[], value: unknown): void;
	delete(path: readonly string[]): void;
}

export function editYamlConfigFile(file: string, edit: (editor: YamlConfigEditor) => void): void {
	const target = realpathSync(file);
	const lock = `${target}.lock`;
	let descriptor: number;
	try {
		descriptor = openSync(lock, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw new Error(
				`${file} is already being edited or an interrupted edit left ${lock}; confirm no edit is running before removing that lock`,
			);
		}
		throw error;
	}
	const temporary = `${target}.${randomUUID()}.tmp`;
	const backup = `${temporary}.bak`;
	try {
		const source = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let text: string;
		let mode: number;
		try {
			mode = fstatSync(source).mode & 0o777;
			text = readFileSync(source, "utf8");
		} finally {
			closeSync(source);
		}
		const document = YAML.parseDocument(text, { prettyErrors: false });
		if (document.errors.length > 0) {
			throw new Error(`${file} is not valid YAML (${document.errors[0]?.message ?? "parse error"}); fix it first`);
		}
		if (document.contents !== null && !YAML.isMap(document.contents)) {
			throw new Error(`${file} must contain a mapping at the top level`);
		}
		edit({
			get: (path) => {
				const value = document.getIn(path);
				return YAML.isNode(value) ? value.toJSON() : value;
			},
			set: (path, value) => document.setIn(path, value),
			delete: (path) => {
				document.deleteIn(path);
			},
		});
		const next = document.toString();
		if (next === text) return;
		writeConfigReplacement(backup, text, mode);
		writeConfigReplacement(temporary, next, mode);
		if (realpathSync(file) !== target || readFileSync(target, "utf8") !== text) {
			throw new Error(`${file} changed while being edited; retry the config edit`);
		}
		renameSync(backup, `${target}.bak`);
		renameSync(temporary, target);
	} finally {
		try {
			rmSync(temporary, { force: true });
			rmSync(backup, { force: true });
		} finally {
			closeSync(descriptor);
			rmSync(lock);
		}
	}
}

function writeConfigReplacement(path: string, text: string, mode: number): void {
	const descriptor = openSync(path, "wx", 0o600);
	try {
		writeFileSync(descriptor, text);
		fchmodSync(descriptor, mode);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
