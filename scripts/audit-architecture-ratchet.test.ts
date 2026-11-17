import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/audit-architecture-ratchet.ts");
const repos: string[] = [];
const FILE = "platform/daemon/src/routes/example.ts";

function git(root: string, ...args: readonly string[]): string {
	const result = Bun.spawnSync(["git", "-C", root, ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

function commit(root: string): string {
	git(root, "add", "--all");
	git(root, "commit", "--allow-empty", "-qm", "fixture");
	return git(root, "rev-parse", "HEAD");
}

function fixture(files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), "architecture-ratchet-"));
	repos.push(root);
	git(root, "init", "-q", "--initial-branch=main");
	git(root, "config", "user.name", "Ratchet Test");
	git(root, "config", "user.email", "ratchet@example.invalid");
	write(root, "scripts/retired-paths.json", "[]");
	for (const [path, content] of Object.entries(files)) write(root, path, content);
	git(root, "update-ref", "refs/remotes/origin/main", commit(root));
	return root;
}

function audit(root: string, ...args: readonly string[]): { readonly code: number; readonly output: string } {
	const home = mkdtempSync(join(tmpdir(), "architecture-ratchet-home-"));
	repos.push(home);
	const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
		cwd: root,
		env: {
			...process.env,
			HOME: join(home, ".home"),
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".data"),
			XDG_CACHE_HOME: join(home, ".cache"),
			SIGNET_PATH: join(home, ".signet"),
		},
	});
	return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

afterEach(() => {
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const cases = [
	{ category: "raw-sql", violation: 'export const sql = "SELECT id FROM memories";' },
	{ category: "swallowed-error", violation: "export function f() { try { work(); } catch {} }" },
	{ category: "unchecked-cast", violation: "export async function f() { return (await c.req.json()) as Body; }" },
] as const;

for (const { category, violation } of cases) {
	test(`${category}: growth in an existing file fails`, () => {
		const root = fixture({ [FILE]: "export const value = 1;" });
		write(root, FILE, violation);
		commit(root);
		const result = audit(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`${FILE}\t${category}\t0 -> 1`);
	});

	test(`${category}: new violating files fail`, () => {
		const root = fixture({ "README.md": "base" });
		write(root, FILE, violation);
		commit(root);
		const result = audit(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`${FILE}\t${category}\t0 -> 1`);
	});

	for (const reduced of [false, true]) {
		test(`${category}: ${reduced ? "reductions" : "unchanged files"} pass`, () => {
			const root = fixture({ [FILE]: violation });
			if (reduced) write(root, FILE, "export const value = 1;");
			commit(root);
			expect(audit(root).code).toBe(0);
		});
	}

	for (const copied of [false, true]) {
		test(`${category}: ${copied ? "copies" : "renames"} inherit their source's base count`, () => {
			const root = fixture({ [FILE]: violation });
			const target = "platform/daemon/src/renamed.ts";
			if (copied) write(root, target, violation);
			else git(root, "mv", FILE, target);
			commit(root);
			expect(audit(root).code).toBe(copied ? 1 : 0);
		});
	}

	test(`${category}: moving a violation to an existing file fails on that file`, () => {
		const target = "platform/daemon/src/target.ts";
		const root = fixture({ [FILE]: violation, [target]: "export const value = 1;" });
		write(root, FILE, "export const value = 1;");
		write(root, target, violation);
		commit(root);
		const result = audit(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`${target}\t${category}\t0 -> 1`);
	});
}

test("raw SQL reports all text, transport, accessor and marker forms", () => {
	const root = fixture({ "README.md": "base" });
	const statements = [
		'"SELECT id FROM memories"',
		`\`SELECT \${column} FROM \${table}\``,
		'"INSERT INTO memories VALUES (?)"',
		'"INSERT OR IGNORE INTO memories VALUES (?)"',
		'"UPDATE memories SET content = ?"',
		'"DELETE FROM memories"',
		'"REPLACE INTO memories VALUES (?)"',
		'"CREATE TABLE memories (id TEXT)"',
		'"CREATE UNIQUE INDEX idx ON memories(id)"',
		'"DROP TRIGGER IF EXISTS trigger"',
		'"ALTER TABLE memories ADD COLUMN value TEXT"',
		'"PRAGMA table_info(memories)"',
	];
	write(
		root,
		FILE,
		[
			...statements.map((sql, index) => `const sql${index} = ${sql};`),
			'import { ownerReadOne as read } from "../db-owner-sql";',
			"ownerReadAll(client, sql); read(client, sql); ownerRun(client, sql); ownerBatch(client, []);",
			'const requests = [{ kind: "query" }, { kind: "transaction" }, { kind: "batch" }];',
			"accessor.withReadDb(work); accessor.withWriteTx(work); accessor.withReadDbAsync(work); accessor.withWriteTxAsync(work); accessor.withWriteDbAsync(work);",
			"/" + "/ @ts-expect-error LEGACY_SYNC_DB_ACCESS",
			"accessor.withReadDb(work);",
		].join("\n"),
	);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain("raw-sql\t0 -> 26");
	expect(result.output).toContain("text=12, helper=4, request=3, accessor=6, marker=1");
});

test("swallowed catch forms include logging and literal defaults", () => {
	const root = fixture({ "README.md": "base" });
	write(
		root,
		FILE,
		[
			"try { work(); } catch {}",
			"try { work(); } catch (error) { console.error(error); }",
			"function f() { try { work(); } catch (error) { logger.warn(error); return null; } }",
			"work().catch(() => {});",
			"work().catch(function (error) { log.error(error); });",
			"work().catch(() => undefined);",
			"work().catch(() => null);",
			"work().catch(() => false);",
			"work().catch(() => -1);",
			'work().catch(() => "missing");',
			"work().catch(() => []);",
			"work().catch(() => ({}));",
			"work().catch(error => console.error(error));",
		].join("\n"),
	);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain("swallowed-error\t0 -> 13");
});

test("casts cover request JSON and database trust boundaries", () => {
	const root = fixture({ "README.md": "base" });
	write(
		root,
		FILE,
		[
			'import { ownerReadOne as read } from "../db-owner-sql";',
			"const a = (await c.req.json()) as Body;",
			"const b = <Body>(await req.json());",
			"const c = (await request.json().catch(handle)) as Body;",
			"const d = stmt.all() as Row[];",
			"const e = stmt.get() as Row;",
			"const f = stmt.run() as Result;",
			"const g = stmt.values() as unknown[];",
			"const h = db.prepare(sql).bind(value).all() as Row[];",
			"const i = db.prepare(sql) as Statement;",
			"const j = (await ownerReadAll(client, sql)) as Row[];",
			"const k = (await ownerReadOne(client, sql)) as Row;",
			"ownerReadAll<Row>(client, sql);",
			"read<Row>(client, sql);",
			"const l = (await read(client, sql)) as Row;",
		].join("\n"),
	);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain("unchecked-cast\t0 -> 14");
});

test("handled errors, checked values and named operations are not violations", () => {
	const root = fixture({ "README.md": "base" });
	write(
		root,
		FILE,
		[
			'const value = { kind: "recall" } as const;',
			"const literal = stmt.all() as const;",
			"const field = row.id as string;",
			"const body = await req.json(); validate(body);",
			"const response = await response.json() as ResponseBody;",
			"try { work(); } catch (error) { throw error; }",
			"try { work(); } catch (error) { state.error = error; }",
			"function f() { try { work(); } catch (error) { return error.message; } }",
			"work().catch(error => ({ ok: false, error }));",
			"work().catch(error => recover(error));",
			"work().catch(error => { state.error = error; });",
			"work().catch(error => { throw error; });",
			'const request = { kind: "memory_head" };',
		].join("\n"),
	);
	commit(root);
	expect(audit(root).code).toBe(0);
});

test("only the expected-miss helpers' own catches are exempt", async () => {
	const path = "platform/core/src/attempt.ts";
	const helpers = await Bun.file(join(ROOT, path)).text();
	const root = fixture({ "README.md": "base" });
	write(root, path, helpers);
	commit(root);
	expect(audit(root).code).toBe(0);
	write(root, path, `${helpers}\nfunction unrelated() { try { work(); } catch {} }`);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain(`${path}\tswallowed-error\t0 -> 1`);
});

test("owner SQL is exempt but casts and swallowed errors are not", () => {
	const path = "platform/daemon/src/db-owner-worker.ts";
	const root = fixture({ "README.md": "base" });
	write(
		root,
		path,
		'const sql = "SELECT id FROM memories"; const row = db.prepare(sql).get() as Row; try { work(); } catch {}',
	);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).not.toContain("\traw-sql\t");
	expect(result.output).toContain("swallowed-error\t0 -> 1");
	expect(result.output).toContain("unchecked-cast\t0 -> 1");
});

test("owner files still ratchet raw owner-protocol and legacy accessor bypasses", () => {
	const path = "platform/daemon/src/memory-search.ts";
	const root = fixture({ [path]: 'export const sql = "SELECT id FROM memories";' });
	write(
		root,
		path,
		[
			'export const sql = "SELECT id FROM memories";',
			'export const more = "SELECT id FROM entities";',
			"ownerReadAll(client, sql);",
			'const request = { kind: "query" };',
			"accessor.withWriteTx(work);",
		].join("\n"),
	);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain("raw-sql\t0 -> 3 (text=0, helper=1, request=1, accessor=1, marker=0)");
});

test("production scope excludes fixtures, tests, generated and non-runtime trees", () => {
	const root = fixture({ "README.md": "base" });
	const violation = cases.map(({ violation }) => violation).join("\n");
	for (const path of [
		"platform/core/src/migrations/172-example.ts",
		"platform/daemon/src/example.test.ts",
		"platform/daemon/src/example.bench.ts",
		"platform/daemon/src/__tests__/example.ts",
		"platform/daemon/src/test-support/example.ts",
		"platform/daemon/src/fixtures/example.ts",
		"platform/daemon/dist/example.ts",
		"web/example.ts",
		"memorybench/example.ts",
		"references/example.ts",
	])
		write(root, path, path.includes("migrations") ? 'const sql = "CREATE TABLE example (id TEXT)";' : violation);
	commit(root);
	expect(audit(root).code).toBe(0);
});

test("base refs resolve to merge-base, not a divergent tip", () => {
	const root = fixture({ [FILE]: "export const value = 1;" });
	git(root, "checkout", "-qb", "base-branch");
	write(root, FILE, cases[0].violation);
	write(root, "base-only.md", "divergent branch");
	commit(root);
	git(root, "checkout", "-q", "main");
	write(root, FILE, cases[0].violation);
	commit(root);
	expect(audit(root, "--base", "base-branch").code).toBe(1);
	expect(audit(root, "--base", "HEAD").code).toBe(0);
});

test("the real repository audits cleanly against its own HEAD", () => {
	const result = audit(ROOT, "--base", "HEAD");
	expect(result.output).toContain("Architecture ratchet passed");
	expect(result.code).toBe(0);
}, 120_000);

const RETIRED = "scripts/obsolete-example.ts";
const TOMBSTONES = JSON.stringify([{ path: RETIRED, reason: "Retired workflow", retiredIn: "architecture-ratchet" }]);

for (const committed of [false, true]) {
	test(`retired paths cannot return ${committed ? "in HEAD" : "untracked"}`, () => {
		const root = fixture({ "scripts/retired-paths.json": TOMBSTONES });
		write(root, RETIRED, "export const obsolete = true;");
		if (committed) commit(root);
		const result = audit(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`Retired path exists: ${RETIRED}`);
	});
}

test("tracked references to retired paths fail outside docs and the registry", () => {
	const root = fixture({ "scripts/retired-paths.json": TOMBSTONES });
	write(root, "package.json", JSON.stringify({ scripts: { obsolete: `bun ${RETIRED}` } }));
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain(`package.json references retired path: ${RETIRED}`);
});

test("historical docs references and the registry itself remain valid", () => {
	const root = fixture({ "scripts/retired-paths.json": TOMBSTONES, "docs/history.md": RETIRED });
	commit(root);
	expect(audit(root).code).toBe(0);
});

test("missing or malformed retirement registries fail closed", () => {
	const root = fixture({ "scripts/retired-paths.json": "{}" });
	expect(audit(root).code).toBe(1);
	git(root, "rm", "scripts/retired-paths.json");
	commit(root);
	expect(audit(root).code).toBe(1);
});

for (const { category, violation } of cases) {
	test(`${category}: splitting a copied file inherits the original base count`, () => {
		const padding = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const root = fixture({ [FILE]: `${padding}\n${violation}\n${violation}` });
		write(root, FILE, `${padding}\n${violation}`);
		write(root, "platform/daemon/src/split.ts", `${padding}\n${violation}`);
		commit(root);
		expect(audit(root).code).toBe(0);
	});
}

test("all production roots and TSX files are audited", () => {
	const root = fixture({ "README.md": "base" });
	const paths = ["surfaces/example/src/index.tsx", "libs/example/src/index.ts", "integrations/example/plugin/index.ts"];
	for (const path of paths) write(root, path, cases[1].violation);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	for (const path of paths) expect(result.output).toContain(`${path}\tswallowed-error\t0 -> 1`);
});

test("moving SQL out of the owner closure cannot carry its exemption", () => {
	const source = "platform/daemon/src/db-owner-worker.ts";
	const root = fixture({ [source]: cases[0].violation });
	mkdirSync(dirname(join(root, FILE)), { recursive: true });
	git(root, "mv", source, FILE);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain(`${FILE}\traw-sql\t0 -> 1`);
});

test("named owner handlers retain their SQL authority without exempting transports", () => {
	const root = fixture({ "README.md": "base" });
	for (const path of [
		"platform/daemon/src/memory-search.ts",
		"platform/daemon/src/pipeline/dreaming-capabilities.ts",
		"platform/daemon/src/session-transcripts.ts",
	]) {
		write(root, path, cases[0].violation);
	}
	commit(root);
	expect(audit(root).code).toBe(0);
	const transport = "platform/daemon/src/db-owner-sql.ts";
	write(root, transport, cases[0].violation);
	commit(root);
	const result = audit(root);
	expect(result.code).toBe(1);
	expect(result.output).toContain(`${transport}\traw-sql\t0 -> 1`);
});

test("copies share one baseline", () => {
	const root = fixture({ [FILE]: `${cases[1].violation}\n${cases[1].violation}` });
	const target = "platform/daemon/src/copy.ts";
	write(root, target, `${cases[1].violation}\n${cases[1].violation}`);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${FILE}\tswallowed-error\t2 -> 4 [${target}=2, ${FILE}=2]\n`,
	});
});

test("callback evasions are counted", () => {
	const root = fixture({ "README.md": "base" });
	write(
		root,
		FILE,
		`import { noop } from "x";
 const quiet = () => {}; function silence() { void error; }
 work().catch(noop); work().catch(quiet); work().then(ok, silence);
 work().catch(() => (null as X)); work().catch(() => ({} satisfies X));
 work().catch(() => { return recover(); });`,
	);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${FILE}\tswallowed-error\t0 -> 5\n`,
	});
});

test("named callbacks resolve aliased imports and module-scope declarations only", () => {
	const root = fixture({ "README.md": "base" });
	write(
		root,
		FILE,
		`import { noop as discard } from "x";
const quiet = () => {};
function first() { const handleError = () => {}; work().catch(handleError); }
function second() { const handleError = (error) => { throw error; }; work().catch(handleError); }
work().catch(discard); work().catch(quiet);`,
	);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${FILE}\tswallowed-error\t0 -> 2\n`,
	});
});

test("request JSON annotations and satisfies are counted", () => {
	const root = fixture({ "README.md": "base" });
	write(root, FILE, `const a: Body = await c.req.json().catch(handle); const b = (await req.json()) satisfies Body;`);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${FILE}\tunchecked-cast\t0 -> 2\n`,
	});
});

test("local raw helper aliases are counted", () => {
	const root = fixture({ "README.md": "base" });
	write(
		root,
		FILE,
		`const r = ownerRun; const { ownerReadAll: rr, ownerBatch } = x; r(); rr(); ownerBatch(); ns.ownerReadOne();`,
	);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${FILE}\traw-sql\t0 -> 4 (text=0, helper=4, request=0, accessor=0, marker=0)\n`,
	});
});

test("generated production files are audited", () => {
	const root = fixture({ "README.md": "base" });
	const path = "platform/daemon/src/generated/example.ts";
	write(root, path, cases[1].violation);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\n${path}\tswallowed-error\t0 -> 1\n`,
	});
});

test("markdown references are exempt but code references are not", () => {
	const root = fixture({ "scripts/retired-paths.json": TOMBSTONES });
	write(root, "nested/README.md", RETIRED);
	commit(root);
	const base = git(root, "rev-parse", "origin/main");
	expect(audit(root)).toEqual({
		code: 0,
		output: `Architecture ratchet passed against ${base}: 0 files; raw-sql=0, swallowed-error=0, unchecked-cast=0\n`,
	});
	write(root, "config.yml", RETIRED);
	commit(root);
	expect(audit(root)).toEqual({
		code: 1,
		output: `Architecture ratchet failed against ${base}:\nfile\tcategory\tbase -> head\nconfig.yml references retired path: ${RETIRED}\n`,
	});
});
