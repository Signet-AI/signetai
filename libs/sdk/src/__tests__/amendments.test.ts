import "../../../../tests/support/connector-safety.js";
import ts from "typescript";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, chmod, symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { withFileLock } from "../node/storage.js";
import { SignetTransport } from "../transport.js";
import { SignetNetworkError } from "../errors.js";
import { LoginStore, readKeyFile } from "../node.js";

test("credential provider failure is terminal and not a network error", async () => {
	let calls = 0;
	const client = new SignetTransport({
		baseUrl: "https://unused.example",
		retryDelayMs: 1,
		credentialProvider: async () => {
			calls++;
			throw new Error("locked");
		},
	});
	let failure: unknown;
	try {
		await client.get("/health");
	} catch (error) {
		failure = error;
	}
	expect(calls).toBe(1);
	expect(failure).toMatchObject({ code: "credential_provider_error" });
	expect(failure).not.toBeInstanceOf(SignetNetworkError);
});

test("built browser entry has no transitive node specifier", async () => {
	const root = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
	const seen = new Set<string>();
	const visit = async (path: string): Promise<void> => {
		if (seen.has(path)) return;
		seen.add(path);
		const text = await readFile(path, "utf8");
		const specifiers = new Set(new Bun.Transpiler({ loader: "js" }).scanImports(text).map((item) => item.path));
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const inspect = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const expr = node.expression;
				const loader =
					expr.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(expr) && expr.text === "require") ||
					(ts.isPropertyAccessExpression(expr) &&
						((expr.name.text === "require" && ts.isMetaProperty(expr.expression)) ||
							(expr.name.text === "resolve" &&
								ts.isIdentifier(expr.expression) &&
								expr.expression.text === "require")));
				const arg = node.arguments[0];
				if (loader && arg && ts.isStringLiteralLike(arg)) specifiers.add(arg.text);
			}
			ts.forEachChild(node, inspect);
		};
		inspect(source);
		for (const specifier of specifiers) {
			expect(specifier, `${path} imports ${specifier}`).not.toStartWith("node:");
			const child = Bun.spawn(
				[
					"node",
					"--experimental-import-meta-resolve",
					"--conditions=browser",
					"--input-type=module",
					"--eval",
					"console.log(import.meta.resolve(process.argv[1], process.argv[2]))",
					specifier,
					pathToFileURL(path).href,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const resolved = (await new Response(child.stdout).text()).trim();
			const error = await new Response(child.stderr).text();
			expect(await child.exited, error).toBe(0);
			expect(resolved).not.toStartWith("node:");
			await visit(fileURLToPath(resolved));
		}
	};
	await visit(root);
});

test.skipIf(process.platform === "win32")("symlinked keys are validated on the opened regular target", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-key-link-"));
	try {
		const target = join(home, "key");
		const link = join(home, "link");
		await writeFile(target, "fixture", { mode: 0o600 });
		await symlink(target, link);
		expect(await readKeyFile(link)).toBe("fixture");
		await chmod(target, 0o644);
		await expect(readKeyFile(link)).rejects.toThrow("permissions");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")("FIFO key refusal cannot block opening the file", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-key-fifo-"));
	try {
		const fifo = join(home, "key");
		expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
		const module = new URL("../node.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`import {readKeyFile} from ${JSON.stringify(module)};setTimeout(()=>process.exit(2),350);try{await readKeyFile(${JSON.stringify(fifo)});process.exit(3)}catch{process.exit(0)}`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await child.exited).toBe(0);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

const loginFixture = {
	accessToken: "access-fixture",
	refreshToken: "refresh-fixture",
	accessExpiresAt: "2020-01-01T00:00:00Z",
	refreshExpiresAt: "2099-01-01T00:00:00Z",
};
for (const status of [503, 403])
	test(`refresh preserves HTTP ${status}`, async () => {
		const home = await mkdtemp(join(tmpdir(), "sdk-refresh-"));
		const server = Bun.serve({ port: 0, fetch: () => Response.json({ reason: "permission" }, { status }) });
		const keyring = {
			get: async () => ({ state: "found" as const, value: JSON.stringify(loginFixture) }),
			set: async () => ({ state: "found" as const }),
		};
		try {
			const store = new LoginStore(`http://127.0.0.1:${server.port}`, { env: { HOME: home }, keyring });
			await expect(store.accessToken()).rejects.toMatchObject({ status });
		} finally {
			server.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	});
test("refresh dead login persists and short circuits another store", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-dead-"));
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			return Response.json({ reason: "revoked" }, { status: 401 });
		},
	});
	const keyring = {
		get: async () => ({ state: "found" as const, value: JSON.stringify(loginFixture) }),
		set: async () => ({ state: "found" as const }),
	};
	try {
		for (let n = 0; n < 2; n++) {
			const store = new LoginStore(`http://127.0.0.1:${server.port}`, { env: { HOME: home }, keyring });
			await expect(store.accessToken()).rejects.toMatchObject({ reason: "revoked" });
		}
		expect(calls).toBe(1);
	} finally {
		server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
});
test("refresh in doubt retries rotated pair without another refresh", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-doubt-"));
	let calls = 0;
	let failing = true;
	let encoded = JSON.stringify(loginFixture);
	const rotated = { ...loginFixture, accessToken: "rotated-fixture", accessExpiresAt: "2099-01-01T00:00:00Z" };
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			return Response.json(rotated);
		},
	});
	const keyring = {
		get: async () => ({ state: "found" as const, value: encoded }),
		set: async (value: string) => {
			if (failing) throw new Error("disk unavailable");
			encoded = value;
			return { state: "found" as const };
		},
	};
	try {
		const store = new LoginStore(`http://127.0.0.1:${server.port}`, { env: { HOME: home }, keyring });
		await expect(store.accessToken()).rejects.toMatchObject({ reason: "refresh_in_doubt" });
		failing = false;
		expect(await store.accessToken()).toBe(rotated.accessToken);
		expect(calls).toBe(1);
	} finally {
		server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
});

for (const mode of ["corrupt", "reused", "aged"])
	test(`lock recovers ${mode} participant`, async () => {
		const home = await mkdtemp(join(tmpdir(), "sdk-owner-"));
		const path = join(home, ".lock");
		const token = randomUUID();
		try {
			await mkdir(`${path}.tickets`, { mode: 0o700 });
			const record = {
				pid: process.pid,
				token,
				choosing: true,
				ticket: 0,
				startTime:
					mode === "aged" && process.platform === "linux"
						? `linux:${(await readFile("/proc/self/stat", "utf8")).split(")").at(-1)?.trim().split(/\s+/)[19]}`
						: "reused",
				createdAt: mode === "aged" ? 0 : Date.now(),
			};
			await writeFile(join(`${path}.tickets`, `${token}.json`), mode === "corrupt" ? "{" : JSON.stringify(record), {
				mode: 0o600,
			});
			expect(await withFileLock(path, async () => true, AbortSignal.timeout(200))).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

test("an existing store observes another store's new login", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-new-login-"));
	let encoded = JSON.stringify(loginFixture);
	const keyring = {
		get: async () => ({ state: "found" as const, value: encoded }),
		set: async (value: string) => {
			encoded = value;
			return { state: "found" as const };
		},
	};
	const server = Bun.serve({ port: 0, fetch: () => Response.json({ reason: "revoked" }, { status: 401 }) });
	try {
		const origin = `http://127.0.0.1:${server.port}`;
		const first = new LoginStore(origin, { env: { HOME: home }, keyring });
		await expect(first.accessToken()).rejects.toMatchObject({ reason: "revoked" });
		const second = new LoginStore(origin, { env: { HOME: home }, keyring });
		await second.save({
			...loginFixture,
			accessToken: "new-login-fixture",
			refreshToken: "new-login-refresh",
			accessExpiresAt: "2099-01-01T00:00:00Z",
		});
		expect(await first.accessToken()).toBe("new-login-fixture");
	} finally {
		server.stop(true);
		await rm(home, { recursive: true, force: true });
	}
});
test.each(["throw", "unavailable", "unsupported"] as const)(
	"post-rotation %s reread cannot shadow a newer login",
	async (kind) => {
		const home = await mkdtemp(join(tmpdir(), "sdk-reread-"));
		let encoded = JSON.stringify(loginFixture);
		let unreadable = false;
		let calls = 0;
		const rotated = {
			...loginFixture,
			accessToken: "new-pair-fixture",
			refreshToken: "new-pair-refresh",
			accessExpiresAt: "2099-01-01T00:00:00Z",
		};
		const keyring = {
			get: async () => {
				if (unreadable) {
					if (kind === "throw") throw new Error("credential backend unreadable");
					return { state: kind };
				}
				return { state: "found" as const, value: encoded };
			},
			set: async (value: string) => {
				encoded = value;
				return { state: "found" as const };
			},
		};
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				unreadable = true;
				return Response.json(rotated);
			},
		});
		try {
			const store = new LoginStore(`http://127.0.0.1:${server.port}`, { env: { HOME: home }, keyring });
			await expect(store.accessToken()).rejects.toMatchObject({ reason: "refresh_in_doubt" });
			const newer = { ...rotated, accessToken: "newer-login-fixture", refreshToken: "newer-login-refresh" };
			encoded = JSON.stringify(newer);
			await expect(store.accessToken()).rejects.toMatchObject({ reason: "refresh_in_doubt" });
			expect(encoded).toBe(JSON.stringify(newer));
			unreadable = false;
			expect(await store.accessToken()).toBe(newer.accessToken);
			expect(calls).toBe(1);
		} finally {
			server.stop(true);
			await rm(home, { recursive: true, force: true });
		}
	},
);
