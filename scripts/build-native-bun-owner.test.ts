import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { findSqliteVecExtension } from "../platform/core/src/database";
import { join, resolve } from "node:path";
import { nativeWorkerBootstrap } from "./lib/native-worker-bootstrap";

test.each(["kernel", "inline"])("bundled owner %s loads its native scan without the parent asset registry", (mode) => {
	const root = resolve(import.meta.dir, "..");
	const directory = mkdtempSync(join(tmpdir(), "signet-owner-native-"));
	try {
		const suffix = `${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : process.platform === "win32" ? "-msvc" : ""}`;
		const addon = join(root, "platform/native", `signet-native.${suffix}.node`);
		const registry = join(root, "platform/daemon/src/native-runtime-assets.ts");
		const entry = join(directory, "owner.ts");
		writeFileSync(
			entry,
			`import { materializeEmbeddedNativeAddon } from ${JSON.stringify(registry)};
const path=materializeEmbeddedNativeAddon("signet-native");
if(!path)throw Error("owner_native_asset_missing");
const addon=require(path);
const rows=Buffer.alloc(8);rows.writeBigInt64LE(1n);
const result=addon.scanAdmittedVectors(new Float32Array([1,0,0]),[{vectors:Buffer.from(new Float32Array([1,0,0]).buffer),rowids:rows,validity:Buffer.from([1]),eligibility:Buffer.from([1])}],1);
${
	mode === "inline"
		? `
const {Database}=await import("bun:sqlite");
const core=await import(${JSON.stringify(join(root, "platform/core/src/index.ts"))});
const workspace=${JSON.stringify(directory)};
process.env.SIGNET_PATH=workspace;process.env.SIGNET_WORKSPACE=workspace;
process.env.SIGNET_DB_OWNER_WORKER="1";
const dbPath=workspace+"/signet.db", db=new Database(dbPath);
db.loadExtension(core.findSqliteVecExtension());db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL");core.runMigrations(db);
db.exec("DROP TABLE vec_embeddings;CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[768] distance_metric=cosine)");
const vector=new Float32Array(768);vector[0]=1;
db.exec("INSERT INTO memories(id,content,created_at,updated_at,agent_id) VALUES('inline-memory','fixture','2020','2020','default')");
db.query("INSERT INTO embeddings(id,content_hash,source_type,source_id,vector,dimensions,created_at,agent_id,chunk_text) VALUES('inline-vector','hash','memory','inline-memory',?,768,'2020','default','')").run(vector);
db.query("INSERT INTO vec_embeddings(id,embedding) VALUES('inline-vector',?)").run(vector);
core.beginVectorAdmissionRepairInTx(db,"vec_embeddings","embeddings");
for(let n=0;n<10;n++){const step=core.stepVectorAdmissionRepairInTx(db,"vec_embeddings");if(step.phase==="prepared"){core.publishVectorAdmissionRepairInTx(db,"vec_embeddings");break;}}
db.close();
const accessor=await import(${JSON.stringify(join(root, "platform/daemon/src/db-accessor.ts"))});
accessor.initDbAccessor(dbPath,{agentsDir:workspace});
const runtime=await import(${JSON.stringify(join(root, "platform/daemon/src/db-owner-runtime.ts"))});
const recall=await import(${JSON.stringify(join(root, "platform/daemon/src/db-owner-recall.ts"))});
const response=await recall.vectorSearchThroughDbOwner(await runtime.getDbRecallOwner(dbPath),[...vector],{limit:1,readScope:{reach:{kind:"own",agentId:"default"},projects:null,compartments:"all"}});
result.inline={completeness:response.completeness,ids:response.results.map(row=>row.id)};
`
		: ""
}
console.log(JSON.stringify(result));process.exit(0);`,
		);
		const bootstrap = join(directory, "bootstrap.ts");
		writeFileSync(
			bootstrap,
			nativeWorkerBootstrap(entry, registry, [
				{ name: "signet-native", contentBase64: readFileSync(addon).toString("base64") },
			]),
		);
		const bundle = join(directory, "worker.mjs");
		const build = spawnSync(
			process.execPath,
			[
				"build",
				"--target=bun",
				"--format=esm",
				"--loader",
				".wasm:base64",
				"--external",
				"better-sqlite3",
				"--external",
				"@napi-rs/keyring",
				"--outfile",
				bundle,
				bootstrap,
			],
			{ encoding: "utf8" },
		);
		if (build.status !== 0) throw Error(build.stderr);
		expect(build.status).toBe(0);
		const result = spawnSync(process.execPath, [bundle], {
			cwd: directory,
			env: {
				...process.env,
				TMPDIR: directory,
				SIGNET_VEC_PATH: findSqliteVecExtension() ?? undefined,
				SIGNET_TIKTOKEN_WASM_PATH: createRequire(join(root, "platform/daemon/package.json")).resolve(
					"tiktoken/tiktoken_bg.wasm",
				),
			},
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			rows: [{ rowid: "1", distance: 0 }],
			scannedRows: 1,
			eligibleRows: 1,
			heapPeak: 1,
			...(mode === "inline" ? { inline: { completeness: "complete", ids: ["inline-memory"] } } : {}),
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
