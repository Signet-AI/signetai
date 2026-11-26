import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const operation of ["save", "clear"])
	test(`login ${operation} does not acknowledge an unconfirmed marker deletion`, async () => {
		const home = await mkdtemp(join(tmpdir(), "sdk-login-state-"));
		const module = new URL("../node/login.ts", import.meta.url).href;
		const code = `import{mock}from'bun:test';import*as fs from'node:fs/promises';import{dirname}from'node:path';const realRm=fs.rm,realOpen=fs.open;let statePath='',removed=false;mock.module('node:fs/promises',()=>({...fs,rm:async(path,opts)=>{await realRm(path,opts);if(path===statePath)removed=true},open:async(...args)=>{const h=await realOpen(...args);const sync=h.sync.bind(h);h.sync=async()=>{if(removed&&args[0]===dirname(statePath))throw new Error('marker deletion unconfirmed');return sync()};return h}}));const{LoginStore}=await import(${JSON.stringify(module)});const store=new LoginStore('https://remote.example',{env:{HOME:process.env.HOME},keyring:{get:async()=>({state:'missing'}),set:async()=>({state:'unavailable'})}});const value={accessToken:'fixture',refreshToken:'fixture-refresh',accessExpiresAt:'2099-01-01T00:00:00Z',refreshExpiresAt:'2099-01-02T00:00:00Z'};await store.save(value);statePath=store.path+'.state';await fs.writeFile(statePath,JSON.stringify({state:'dead',reason:'revoked'}),{mode:0o600});let refused=false;try{await store.${operation}(${operation === "save" ? "value" : ""})}catch(e){refused=e.message==='marker deletion unconfirmed'}if(!refused)throw new Error('unconfirmed marker deletion acknowledged');`;
		try {
			const child = Bun.spawn([process.execPath, "--eval", code], {
				env: { ...process.env, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			});
			const error = await new Response(child.stderr).text();
			expect(await child.exited, error).toBe(0);
		} finally {
			await rm(home, { force: true, recursive: true });
		}
	});
