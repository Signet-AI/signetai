import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "linux")("stale lock cleanup cannot unlink a replacement generation", async () => {
	const home = await mkdtemp(join(tmpdir(), "sdk-lock-generation-"));
	try {
		const module = new URL("../node/storage.ts", import.meta.url).href;
		const path = join(home, "mutex");
		const code = `import{mock}from'bun:test';const fs=await import('node:fs/promises');const native={...fs};const path=${JSON.stringify(path)};let armed=false,swapped=false;const replacement=JSON.stringify({pid:process.pid,token:'replacement',startTime:'linux:'+(await native.readFile('/proc/self/stat','utf8')).split(')').at(-1).trim().split(/\\s+/)[19],createdAt:Date.now()});async function swap(){if(!swapped){swapped=true;await native.rename(path,path+'.previous');await native.writeFile(path,replacement,{mode:0o600})}}mock.module('node:fs/promises',()=>({...native,open:async(...args)=>{const h=await native.open(...args);if(String(args[0])!==path)return h;return new Proxy(h,{get(target,key){if(key==='readFile')return async(...a)=>{const text=await target.readFile(...a);if(armed&&!swapped)await swap();return text};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})},rm:async(p,opts)=>{if(String(p)===path&&armed&&!swapped)await swap();return native.rm(p,opts)}}));const{withFileLock}=await import(${JSON.stringify(module)});await withFileLock(path,async()=>{if(await native.stat(path).then(()=>true,()=>false)){armed=true}else{await native.writeFile(path,replacement,{mode:0o600});swapped=true}});if(JSON.parse(await native.readFile(path,'utf8')).token!=='replacement')throw new Error('replacement owner was deleted');`;
		const child = Bun.spawn([process.execPath, "--eval", code], {
			env: { ...process.env, HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(0);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
