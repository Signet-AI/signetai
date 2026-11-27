import "../../../../tests/support/connector-safety.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorRegistry, DurableOutbox, LoginStore, readKeyFile, resolveTarget, writeKeyFile } from "../node.js";
import conformance from "../../../../tests/fixtures/connector-conformance.json";

let home: string;
let env: Record<string, string | undefined>;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "sdk-node-"));
	env = { HOME: home, APPDATA: join(home, "AppData", "Roaming") };
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});
const absentKeyring = {
	get: async () => ({ state: "unavailable" as const }),
	set: async (_value: string) => ({ state: "unavailable" as const }),
};

for (const fixture of conformance.targets) {
	test(`shared target conformance: ${fixture.name}`, async () => {
		const fixtureEnv = { ...env, ...fixture.env };
		const registry = fixture.registry;
		if (registry) {
			const keyFile = registry.key
				? await writeKeyFile(registry.url, conformance.harness, registry.key, { env: fixtureEnv })
				: undefined;
			await new ConnectorRegistry({ env: fixtureEnv }).set(conformance.harness, {
				url: registry.url,
				...(keyFile ? { keyFile } : {}),
			});
		}
		const target = await resolveTarget({
			harness: conformance.harness,
			env: fixtureEnv,
			keyring: absentKeyring,
			flagUrl: fixture.flagUrl ?? undefined,
			flagKey: fixture.flagKey ?? undefined,
			configUrl: fixture.configUrl ?? undefined,
		});
		expect(target.url).toBe(fixture.expected.url);
		expect(target.credential.source).toBe(fixture.expected.source);
		expect(await target.credential.get()).toBe(fixture.expected.credential);
		expect(target.remote).toBe(fixture.expected.remote);
	});
}

test("explicit HTTP connector targets send origin-bound credentials and warn once per process", async () => {
	const script = `
const source = await import(${JSON.stringify(new URL("../node.ts", import.meta.url).href)});
const bundled = await import(${JSON.stringify(new URL("../../dist/node.js", import.meta.url).href)});
const env = { HOME: process.env.HOME, APPDATA: process.env.APPDATA };
const absent = { get: async () => ({ state: "unavailable" }), set: async () => ({ state: "unavailable" }) };
const key = "fixture-key-" + crypto.randomUUID();
const lan = "http://192.168.20.10:3850";
const tailnet = "http://100.64.20.10:3850";
let expected = key;
const authenticated = [];
globalThis.fetch = async (_url, init) => {
 authenticated.push(new Headers(init.headers).get("authorization") === (expected === null ? null : "Bearer " + expected));
 return Response.json({ ok: true });
};
const keyFile = await source.writeKeyFile(tailnet, "openclaw", key, { env });
await new source.ConnectorRegistry({ env }).set("openclaw", { url: tailnet, keyFile });
for (const [sdk, options] of [
 [source, { env: { ...env, SIGNET_DAEMON_URL: lan, SIGNET_API_KEY: key } }],
 [bundled, { env, harness: "openclaw" }],
 [source, { env: { ...env, SIGNET_API_KEY: key }, configUrl: lan }],
 [bundled, { env, flagUrl: tailnet, flagKey: key }],
]) {
 const target = await sdk.resolveTarget({ ...options, keyring: absent });
 await new sdk.NodeTransport(target, { env }).get("/health");
}
expected = null;
for (const envUrl of [undefined, tailnet]) {
 const target = await source.resolveTarget({ env: { ...env, SIGNET_API_KEY: key, SIGNET_DAEMON_URL: envUrl }, flagUrl: lan, keyring: absent });
 await new source.NodeTransport(target, { env }).get("/health");
}
console.log(JSON.stringify(authenticated));
`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, ...env, SIGNET_DAEMON_URL: "", SIGNET_API_KEY: "", SIGNET_API_KEY_FILE: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual([true, true, true, true, true, true]);
	expect(stderr.match(/HTTP sends credentials in clear text/g)).toHaveLength(1);
	expect(stderr).not.toContain("fixture-key-");
	expect(stdout).not.toContain("fixture-key-");
});
test("an unbound environment key never follows an explicit URL", async () => {
	const target = await resolveTarget({
		env: { ...env, SIGNET_API_KEY: "fixture" },
		flagUrl: "https://other.example",
		keyring: absentKeyring,
	});
	expect(await target.credential.get()).toBeNull();
});

test("shared outbox record conformance", async () => {
	const box = new DurableOutbox(conformance.outbox.origin, { env, harness: conformance.harness });
	await box.enqueue(conformance.outbox.request);
	const entry = (await box.entries())[0];
	expect(entry).toMatchObject(conformance.outbox.record);
	expect(Object.keys(entry ?? {}).sort()).toEqual(conformance.outbox.recordKeys);
});

test("target and credential precedence is origin-bound and uses core host semantics", async () => {
	const registry = new ConnectorRegistry({ env });
	const keyFile = await writeKeyFile("https://org.example", "hermes", "connector", { env });
	await registry.set("hermes", { url: "https://org.example", keyFile, agentId: "a" });
	const login = new LoginStore("https://org.example", { env, keyring: absentKeyring });
	await login.save({
		accessToken: "login",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
	});
	for (const [options, url, source, credential] of [
		[{}, "https://org.example", "key-file", "connector"],
		[
			{
				flagUrl: "https://flag.example",
				flagKey: "flag",
				env: { ...env, SIGNET_DAEMON_URL: "https://env.example", SIGNET_API_KEY: "env" },
			},
			"https://flag.example",
			"flag",
			"flag",
		],
		[
			{ env: { ...env, SIGNET_DAEMON_URL: "https://env.example", SIGNET_API_KEY: "env" } },
			"https://org.example",
			"key-file",
			"connector",
		],
		[{ flagUrl: "https://other.example" }, "https://other.example", "none", null],
	] as const) {
		const target = await resolveTarget({ harness: "hermes", env, keyring: absentKeyring, ...options });
		expect(target.url).toBe(url);
		expect(target.credential.source).toBe(source);
		expect(await target.credential.get()).toBe(credential);
		expect(target.remote).toBe(true);
	}
	await registry.remove("hermes");
	const target = await resolveTarget({
		env: { ...env, SIGNET_HOST: "localhost", SIGNET_PORT: "4444" },
		keyring: absentKeyring,
	});
	expect(target.url).toBe("http://127.0.0.1:4444");
	expect(target.remote).toBe(false);
	const fromLogin = await resolveTarget({ env, configUrl: "https://org.example", keyring: absentKeyring });
	expect(fromLogin.credential.source).toBe("login-file");
	expect(await fromLogin.credential.get()).toBe("login");
});

test("loopback target overrides and registry entries without credentials stay local", async () => {
	for (const options of [
		{ flagUrl: "http://127.0.0.1:4141" },
		{ configUrl: "http://localhost:4141" },
		{ env: { ...env, SIGNET_DAEMON_URL: "http://127.0.0.1:4141" } },
	])
		expect((await resolveTarget({ env, keyring: absentKeyring, ...options })).remote).toBe(false);
	await new ConnectorRegistry({ env }).set("claude-code", { url: "http://127.0.0.1:4141" });
	expect((await resolveTarget({ env, harness: "claude-code", keyring: absentKeyring })).remote).toBe(false);
	expect((await resolveTarget({ env, flagUrl: "http://127.0.0.1:4141", flagKey: "fixture" })).remote).toBe(true);
});

test("key files and registry are protected, atomic and reject insecure credentials", async () => {
	const path = await writeKeyFile("https://org.example", "hermes", "credential", { env });
	expect(await readKeyFile(path)).toBe("credential");
	if (process.platform !== "win32") {
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await chmod(path, 0o644);
		await expect(readKeyFile(path)).rejects.toThrow("permissions");
	}
	await expect(writeKeyFile("https://org.example", "../escape", "credential", { env })).rejects.toThrow();
	const registry = new ConnectorRegistry({ env });
	await Promise.all(Array.from({ length: 12 }, (_, i) => registry.set(`h${i}`, { url: `https://h${i}.example` })));
	expect(Object.keys(await registry.read())).toHaveLength(12);
	const json = await readFile(join(home, ".config/signet/connectors.json"), "utf8");
	expect(Object.keys(JSON.parse(json))).toHaveLength(12);
	if (process.platform !== "win32")
		expect((await stat(join(home, ".config/signet/connectors.json"))).mode & 0o777).toBe(0o600);
});

test("login keychain writes are reused and fallback source is explicit", async () => {
	let value: string | undefined;
	const keyring = {
		get: async () => (value ? { state: "found" as const, value } : { state: "missing" as const }),
		set: async (next: string) => {
			value = next;
			return { state: "found" as const };
		},
	};
	const store = new LoginStore("https://org.example", { env, keyring });
	const session = {
		accessToken: "access",
		refreshToken: "refresh",
		accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
	};
	expect(await store.save(session)).toBe("keychain");
	expect((await store.load())?.credential).toEqual(session);
	const target = await resolveTarget({ env, configUrl: "https://org.example", keyring });
	expect(target.credential.source).toBe("keychain");
	expect(await target.credential.get()).toBe("access");
	const fallback = new LoginStore("https://fallback.example", { env, keyring: absentKeyring });
	expect(await fallback.save(session)).toBe("login-file");
	const fileTarget = await resolveTarget({ configUrl: "https://fallback.example", env, keyring: absentKeyring });
	expect(fileTarget.credential).toMatchObject({ source: "login-file", reason: "keyring_unavailable" });
	if (process.platform !== "win32") expect((await stat(fallback.path)).mode & 0o777).toBe(0o600);
	expect((await fallback.load())?.source).toBe("login-file");
	await fallback.clear();
	expect(await fallback.load()).toBeNull();
});

test("Python and TypeScript share protected registry, origin hashes and outbox records", async () => {
	const variants = [
		["HTTP://[2001:0DB8:0000:0000:0000:0000:0000:0001]:80/", "http://[2001:db8::1]"],
		["http://[::ffff:192.0.2.128]:8080", "http://[::ffff:c000:280]:8080"],
		["https://bücher.example", "https://xn--bcher-kva.example"],
		["https://faß.example", "https://xn--fa-hia.example"],
		["https://ΟΣ.example", "https://xn--0xai.example"],
		["https://ος.example", "https://xn--0xag.example"],
		["https://ＡＢＣ。example:443", "https://abc.example"],
		["http://%65xample.com:0", "http://example.com:0"],
		["http://0x7f000001", "http://127.0.0.1"],
		["http://0177.1", "http://127.0.0.1"],
		["http://127.000.0.001.", "http://127.0.0.1"],
	] as const;
	const keyFile = await writeKeyFile("https://faß.example", "hermes", "shared", { env });
	await new ConnectorRegistry({ env }).set("hermes", { url: "https://faß.example", keyFile });
	for (const [raw, canonical] of variants) {
		expect((await resolveTarget({ flagUrl: raw, flagKey: "fixture", env })).origin).toBe(canonical);
	}
	const plugin = new URL("../../../../integrations/hermes-agent/connector/hermes-plugin", import.meta.url).pathname;
	const script = `import sys,json; sys.path.insert(0,${JSON.stringify(plugin)}); import signet_transport as s; t=s.resolve_target(harness='hermes'); assert t.credential.get()=='shared'; s.DurableOutbox('https://faß.example').enqueue('POST','/api/hooks/session-end',{'from':'python'}); print(json.dumps([[s.resolve_target(flag_url=raw,flag_key='fixture').origin, s.origin_hash(raw)==s.origin_hash(canonical)] for raw,canonical in ${JSON.stringify(variants)}]))`;
	const child = Bun.spawn(["python3", "-c", script], {
		env: { ...process.env, ...env, SIGNET_DAEMON_URL: "", SIGNET_API_KEY: "", SIGNET_API_KEY_FILE: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual(variants.map(([, canonical]) => [canonical, true]));
	const box = new DurableOutbox("https://xn--fa-hia.example", { env });
	expect((await box.entries())[0]?.body).toEqual({ from: "python" });
	await box.flush(async (entry) => {
		expect(entry.idempotencyKey).toBeTruthy();
	});
	expect((await box.status()).pending).toBe(0);
});

test("explicit target credentials do not consult a broken lower-precedence registry", async () => {
	const registry = new ConnectorRegistry({ env });
	await registry.set("hermes", { url: "https://registry.example" });
	await import("node:fs/promises").then((fs) => fs.writeFile(registry.path, "corrupt"));
	const target = await resolveTarget({
		harness: "hermes",
		flagUrl: "https://flag.example",
		flagKey: "flag",
		env,
		keyring: absentKeyring,
	});
	expect(await target.credential.get()).toBe("flag");
	expect(target.url).toBe("https://flag.example");
});

test("environment key-file beats registry and permissions cannot silently fall back", async () => {
	const envKey = await writeKeyFile("https://org.example", "env", "environment-file", { env });
	const registryKey = await writeKeyFile("https://org.example", "hermes", "registry", { env });
	await new ConnectorRegistry({ env }).set("hermes", { url: "https://org.example", keyFile: registryKey });
	const target = await resolveTarget({
		harness: "hermes",
		env: { ...env, SIGNET_API_KEY_FILE: envKey },
		keyring: absentKeyring,
	});
	expect(target.credential.source).toBe("key-file");
	expect(await target.credential.get()).toBe("environment-file");
	await rm(envKey);
	await expect(target.credential.get()).rejects.toThrow("missing");
});
