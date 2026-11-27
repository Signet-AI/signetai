import { fileURLToPath } from "node:url";
import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function windowsFixture(fixture: string): Promise<unknown[]> {
	const home = await mkdtemp(join(tmpdir(), "sdk-win-acl-"));
	try {
		const helper = join(home, "powershell.exe");
		const key = join(home, "fixture.key");
		const ledger = join(home, "calls");
		await writeFile(key, "fixture", { mode: 0o600 });
		await writeFile(
			helper,
			`#!/usr/bin/env python3
import os,sys,json
with open(os.environ["ACL_LEDGER"],"a") as f:f.write(json.dumps({"action":"spawn"})+"\\n")
if "Get-Process" in sys.argv[-1]:
 print("1")
 sys.exit(0)
for line in sys.stdin:
 v=json.loads(line)
 with open(os.environ["ACL_LEDGER"],"a") as f:f.write(json.dumps(v)+"\\n")
 ok=not(os.path.islink(v["path"]) and not v.get("allowSymlink",True))
 if ok and v.get("write"):os.chmod(v["path"],0o700 if v.get("directory") else 0o600)
 elif ok:ok=not(os.stat(v["path"]).st_mode & 0o077)
 print(json.dumps({"id":v.get("id"),"ok":ok,"code":None if ok else "unsafe_acl"}),flush=True)
 if not ok and v.get("id") is None:sys.exit(2)
`,
			{ mode: 0o700 },
		);
		await chmod(helper, 0o700);
		const child = Bun.spawn([process.execPath, "test", fixture], {
			env: {
				...process.env,
				HOME: home,
				APPDATA: home,
				KEY_FILE: key,
				ACL_LEDGER: ledger,
				PATH: `${home}:${process.env.PATH}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);
		return (await readFile(ledger, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test.skipIf(process.platform === "win32")(
	"Windows ACL worker is reused for warm deliveries and key reads are checked",
	async () => {
		await windowsFixture(fileURLToPath(new URL("../../test-support/windows-warm.fixture.mjs", import.meta.url)));
	},
);
test.skipIf(process.platform === "win32")("directory mutations cannot bless a changed Windows ACL", async () => {
	await windowsFixture(fileURLToPath(new URL("../../test-support/windows-directory.fixture.mjs", import.meta.url)));
});
test.skipIf(process.platform === "win32")(
	"Windows private state rejects links while secure key links work",
	async () => {
		await windowsFixture(fileURLToPath(new URL("../../test-support/windows-links.fixture.mjs", import.meta.url)));
	},
);
