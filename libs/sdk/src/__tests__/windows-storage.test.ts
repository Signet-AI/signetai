import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function windowsFixture(code: string): Promise<unknown[]> {
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
		const child = Bun.spawn([process.execPath, "--eval", code], {
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
const nodeModule = new URL("../node.ts", import.meta.url).href;
const aclModule = new URL("../node/windows-acl.ts", import.meta.url).href;
const storageModule = new URL("../node/storage.ts", import.meta.url).href;

test.skipIf(process.platform === "win32")(
	"Windows ACL worker is reused for warm deliveries and key reads are checked",
	async () => {
		await windowsFixture(
			`import {resolveTarget,NodeTransport} from ${JSON.stringify(nodeModule)};import{chmod,readFile}from'node:fs/promises';Object.defineProperty(process,'platform',{value:'win32'});const server=Bun.serve({port:0,fetch:()=>Response.json({ok:true})});try{const url='http://127.0.0.1:'+server.port;const target=await resolveTarget({flagUrl:url,env:{APPDATA:process.env.HOME,SIGNET_API_KEY_FILE:process.env.KEY_FILE}});const client=new NodeTransport(target,{env:{APPDATA:process.env.HOME}});for(let i=0;i<20;i++)await client.get('/health');await client.flush();await client.post('/api/hooks/session-end',{reason:'session_shutdown'});const count=async()=> (await readFile(process.env.ACL_LEDGER,'utf8')).trim().split('\\n').map(JSON.parse).filter(v=>v.action==='spawn').length;const cold=await count();for(let i=0;i<2;i++)await client.post('/api/hooks/session-end',{reason:'session_shutdown'});if(await count()!==cold)throw new Error('warm deliveries spawned more ACL processes');await chmod(process.env.KEY_FILE,0o644);let refused=false;try{await client.get('/health')}catch(e){refused=e.code==='credential_provider_error'}if(!refused)throw new Error('unsafe ACL accepted')}finally{server.stop(true)}`,
		);
	},
);
test.skipIf(process.platform === "win32")("directory mutations cannot bless a changed Windows ACL", async () => {
	await windowsFixture(
		`import{mkdir,chmod}from'node:fs/promises';import{join}from'node:path';import{windowsAcl,rememberDirectoryMutation}from ${JSON.stringify(aclModule)};Object.defineProperty(process,'platform',{value:'win32'});const dir=join(process.env.HOME,'private');await mkdir(dir,{mode:0o700});await windowsAcl(dir,true,false);await chmod(dir,0o755);await rememberDirectoryMutation(dir);let refused=false;try{await windowsAcl(dir,true,false)}catch(e){refused=e.name==='Error'||e.constructor.name==='UnsafeAclError'}if(!refused)throw new Error('directory mutation blessed unsafe ACL');`,
	);
});
test.skipIf(process.platform === "win32")(
	"Windows private state rejects links while secure key links work",
	async () => {
		await windowsFixture(
			`import{mock}from'bun:test';import*as fs from'node:fs';mock.module('node:fs',()=>({...fs,constants:{...fs.constants,O_NOFOLLOW:0}}));import{symlink}from'node:fs/promises';const{readPrivate}=await import(${JSON.stringify(storageModule)});Object.defineProperty(process,'platform',{value:'win32'});const link=process.env.KEY_FILE+'.link';await symlink(process.env.KEY_FILE,link);if(await readPrivate(link,4096,true)!=='fixture')throw new Error('secure key link refused');let refused=false;try{await readPrivate(link)}catch(e){refused=e.constructor.name==='PrivateFileError'}if(!refused)throw new Error('private state link followed');`,
		);
	},
);
