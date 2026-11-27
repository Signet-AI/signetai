import { expect, test } from "bun:test";
import { runProjectionWorker, stopProjectionWorkers } from "./projection-worker-client";
import type { ProjectionInputRow } from "./umap-projection";
const rows: ProjectionInputRow[] = Array.from({ length: 5000 }, (_, i) => ({
	id: `w-${i}`,
	content: "worker",
	who: null,
	importance: 0.5,
	type: "fact",
	tags: null,
	pinned: 0,
	source_type: "memory",
	source_id: `w-${i}`,
	created_at: "2026-11-25",
	author_user_id: null,
	dimensions: 64,
	vectorHex: Buffer.from(Float32Array.from({ length: 64 }, (_, n) => Math.sin(i + n)).buffer).toString("hex"),
}));
test("B1 worker request abort terminates computation before rejection", async () => {
	const controller = new AbortController();
	const work = runProjectionWorker(rows, 2, controller.signal);
	const outcome = work.then(
		() => null,
		(error: unknown) => error,
	);
	controller.abort();
	expect(await outcome).toMatchObject({ name: "AbortError" });
});
test("B1 worker deadline terminates computation", async () => {
	await expect(runProjectionWorker(rows, 2, undefined, 1)).rejects.toMatchObject({ code: "DB_OWNER_DEADLINE" });
});
test("B1 shutdown cancels and joins active workers", async () => {
	const script = `import {runProjectionWorker,stopProjectionWorkers} from ${JSON.stringify(new URL("./projection-worker-client.ts", import.meta.url).href)};
 const vectorHex=Buffer.from(new Float32Array(64).fill(1).buffer).toString("hex");
 const rows=Array.from({length:5000},(_,i)=>({id:String(i),content:"worker",who:null,importance:0.5,type:"fact",tags:null,pinned:0,source_type:"memory",source_id:String(i),created_at:"2026",author_user_id:null,dimensions:64,vectorHex}));
 const work=runProjectionWorker(rows,2).then(()=>null,error=>error);
 await Bun.sleep(200);await stopProjectionWorkers();const error=await work;if(error?.name!=="AbortError")process.exit(2);
 try{await runProjectionWorker(rows,2);process.exit(3);}catch{console.log("shutdown_joined");}`;
	const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(0);
	expect(await new Response(child.stdout).text()).toContain("shutdown_joined");
});
